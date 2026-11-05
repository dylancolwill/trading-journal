// Build the period-review prompt. Leads with measured execution facts (lib/execution.js),
// then P&L breakdowns, then a compact line per trade. Per-trade AI grades are left out on
// purpose: they are opinions, and the audit showed them tracking rule-conformity more than
// what price actually did.

const { num, holdSeconds, tagNames, sessionOf } = require('./insights');
const { toUtcMs, fmtEt, minutesFromRthOpen } = require('./time');

const money = n => (n == null ? '–' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const oneLine = (s, cap) => {
  const t = String(s || '').replace(/\s*\n+\s*/g, ' | ').replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
};
const dur = s => (s == null ? '?' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`);
const readsTxt = r => (r.reads_right_pct == null ? '–' : `${r.reads_right_pct}% of ${r.reads_decided}`);

function table(title, rows) {
  if (!rows || !rows.length) return '';
  const head = ['group', 'n', 'W/L', 'win%', 'net', 'avg/trade', 'reads right'];
  const body = rows.map(r => [String(r.key), String(r.trades), `${r.wins}/${r.losses}`, `${r.win_rate}%`, money(r.net), money(r.expectancy), readsTxt(r)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const line = c => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
  return [title, line(head), w.map(n => '-'.repeat(n)).join('  '), ...body.map(line)].join('\n') + '\n';
}

function executionSection(e) {
  if (!e || !e.measured) return 'No trades in this period have tick data, so execution could not be measured.\n';
  const pts = t => +(t * e.tick_pts).toFixed(4);
  const gridHead = `stop \\ target (pts)  ${e.targets.map(t => String(pts(t)).padStart(9)).join('')}`;
  const gridRows = e.stops.map(s => `${String(pts(s)).padStart(19)}  ${e.targets.map(t => {
    const c = e.grid.find(g => g.stop_ticks === s && g.target_ticks === t);
    return money(c.net).padStart(9);
  }).join('')}`);
  return `Measured on ${e.measured} of ${e.of} trades (the rest have no tick data).
Normal noise: the median 1-minute range around entries is ${e.noise_1m} pts.
Stops: losers were stopped at a median ${e.stop_median} pts (${e.stop_vs_noise_median}× one normal minute). ${e.losers_inside_noise} of ${e.losers} losers were stopped inside one normal minute's range.
Reads (direction): price travelled two normal minutes' range the trader's way first on ${e.direction.correct} trades and against first on ${e.direction.incorrect} — ${e.direction.correct_pct}% right of ${e.direction.decided} decided; ${e.direction.partial} undecided (no meaningful move within 10 min).
Right idea, still lost: ${e.right_idea_losers} losing trades had a measured-correct direction. Median heat before the best price, on correct reads: ${e.heat_before_peak_when_right} pts.
Exits on winners: median capture ${Math.round((e.capture_median || 0) * 100)}% of the move available within 15 min (${e.captured_pts_median} pts kept of ${e.available_pts_median} available); ${e.winners_under_third} of ${e.winners} winners kept under a third.

WHAT-IF — the same entries, size and fees, but a fixed stop and target placed at entry (first hit within 15 min, otherwise closed at 15 min). Net P&L:
Actual result on these ${e.measured} trades: ${money(e.actual_net)}
${gridHead}
${gridRows.join('\n')}
Best bracket: stop ${pts(e.best.stop_ticks)} / target ${pts(e.best.target_ticks)} → ${money(e.best.net)} (${money(e.best.net - e.actual_net)} vs actual).
Read this grid carefully. It holds the entries fixed and only changes the exit plan. If every cell loses, no exit plan rescues these entries — entry selection is the problem. If wider stops lose MORE, the current tight stops are limiting damage, not causing it. If large targets help, winners are being cut short. Caveats: no slippage, a fixed 15-minute horizon, and it is hindsight on the exit plan only.
`;
}

function tradeLines(trades, exec, maxTrades) {
  const ordered = [...trades].sort((a, b) => String(b.entry_time).localeCompare(String(a.entry_time)));
  const shown = ordered.slice(0, maxTrades);
  const lines = shown.map(t => {
    const ms = toUtcMs(t.entry_time);
    const m = exec[t.id];
    const rth = ms != null ? minutesFromRthOpen(ms) : null;
    const when = ms != null ? `${sessionOf(t)} ${fmtEt(ms)} (${rth < 0 ? 'pre-market' : `RTH +${rth}m`})` : String(t.trade_date);
    const measured = !m ? 'not measured'
      : `${m.direction_verdict}, 5m +${m.mfe_5}/-${m.mae_5}, ${m.stop_pts != null ? `stop ${m.stop_pts} (${m.stop_vs_noise}× noise)` : `kept ${m.realized_pts} of ${m.mfe_15}`}`;
    const tags = tagNames(t).join(', ');
    const net = num(t.net_pnl);
    return `${when} ${t.instrument} ${t.direction} ${t.quantity} | ${net == null ? 'OPEN' : money(net)} | held ${dur(holdSeconds(t))} | measured: ${measured}${tags ? ` | tags: ${tags}` : ''}${t.description ? `\n    notes: ${oneLine(t.description, 300)}` : ''}`;
  });
  return { text: lines.join('\n'), omitted: ordered.length - shown.length };
}

function buildReportPrompt({ stats, trades, exec = {}, from, to, label, maxTrades = 150 }) {
  const o = stats.overall, d = stats.day_stats, al = stats.after_loss, h = stats.hold_seconds;
  const { text: tradeText, omitted } = tradeLines(trades, exec, maxTrades);

  return `You are a trading coach reviewing a futures scalper's recent period. The trader trades the NY session from Australia and reads the market with James Dalton's Auction Market Theory and orderflow (footprint, absorption, imbalance). Your job: tell them, accurately and usefully, where their money is going and the few changes that would matter most.

## How to work
- **Measured facts outrank everything.** The EXECUTION section is computed tick-by-tick from market data; treat it as ground truth. The trader's notes explain intent; P&L tables show results. Build conclusions on the measured facts first.
- **Rank by money.** Lead with what moves the most dollars. A pattern that costs $40 is not worth a paragraph next to one that costs $600.
- **Respect sample size.** Every group shows its n. A group with fewer than about 8 decided reads is an early signal — name it as such, never as a conclusion. Say plainly when the data is too thin to tell.
- **No nitpicking, no generic advice.** Do not critique individual trades for small flaws. Do not give advice that would apply to any trader ("be disciplined", "manage risk", "journal more"). Every recommendation must come from these numbers and be checkable next period.
- **Be fair.** If something is working, say so with the same rigour. If the result is mostly variance, say that.
- All times are New York time. Sessions are NY sessions (a Sydney calendar date can contain two).

## Period
${label} — ${from} to ${to}
${o.trades} trades (${o.closed} closed) over ${d.days} NY sessions.

## Results
Net ${money(o.net)} | win rate ${o.win_rate}% (${o.wins}W / ${o.losses}L / ${o.scratches} scratch) | profit factor ${o.profit_factor ?? '–'} | ${money(o.expectancy)} per trade
Avg win ${money(o.avg_win)} | avg loss ${money(o.avg_loss)} | commission ${money(o.commission)}
Hold: winners ${dur(h.avg_win)}, losers ${dur(h.avg_loss)} | longest streaks ${stats.max_win_streak}W / ${stats.max_loss_streak}L
Sessions ${d.green_days} green / ${d.red_days} red | ${d.avg_trades_per_day} trades per session | worst ${d.worst_day ? `${d.worst_day.key} ${money(d.worst_day.net)}` : '–'} | best ${d.best_day ? `${d.best_day.key} ${money(d.best_day.net)}` : '–'}

## Execution (measured — ground truth)
${executionSection(stats.execution)}
## Where results and reads differ (reads right = measured direction, % of decided)
${table('BY TIMING vs THE 09:30 ET CASH OPEN', stats.by_timing)}
${table('BY SIDE', stats.by_direction)}
${table('BY HALF-HOUR (NY) — 09:00 is pre-market, 09:30 is the cash open', stats.by_hour)}
${table('BY WEEKDAY', stats.by_dow)}
${table('BY INSTRUMENT', stats.by_instrument)}
${table("BY TAG (the trader's own tags; a trade can carry several)", stats.by_tag)}
SESSION LOAD
${d.by_load.map(l => `${l.key.padEnd(11)} ${String(l.days).padStart(3)} sessions, avg ${money(l.avg_day_net)} per session`).join('\n')}

AFTER A LOSS
${al.closed ? `Trades opened within ${al.within_min} min of closing a loss: ${al.closed}, ${al.win_rate}% win, ${money(al.expectancy)}/trade vs ${money(o.expectancy)} overall.` : 'None.'}

## Trades (most recent first${omitted > 0 ? `; ${omitted} older trades are counted above but not listed` : ''})
${tradeText}

## Deliver
Markdown, no title or preamble. Keep it to what a trader would actually read before the next session.

### The short version
Three bullets: the result in one line, the single biggest lever, and the first thing to change.

### Where the money goes
Up to three levers, ranked by dollar impact, each with a bold one-line name, the measured evidence (with n), and an estimate of what it cost this period. Cover entry selection (where reads are right vs wrong), exits on winners, stop sizing (say plainly if the what-if shows tight stops are limiting damage rather than causing it), and timing — but only the ones the data supports.

### What's working
Where reads or results are genuinely good, with n. Keep it short if little is.

### Plan for next period
Three concrete rules, each tied to a lever above and checkable in these same numbers next time (e.g. "no entries before 09:30 ET", "hold winners to X unless Y").

### What to track
Two or three measured numbers from above, each with its current value as the baseline.

End with exactly this block, nothing after it:

---
TOP MISTAKE: <one sentence>
BIGGEST LEAK: <dollar figure> | <one sentence>
FIRST FIX: <one sentence>
TREND: <improving|flat|declining> | <one sentence>`;
}

module.exports = { buildReportPrompt };
