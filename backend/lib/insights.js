// Aggregate a window of trades into the numbers the AI Analysis page shows and the period
// review reads. Pure functions — the route does the querying.
//
// Two kinds of numbers, kept separate on purpose:
//   - P&L facts from the journal (what happened to the account)
//   - execution facts measured from ticks (lib/execution.js): stop size against normal noise,
//     which way price went first, how much of the available move was kept, and what fixed
//     stop/target brackets on the same entries would have produced.
// Per-trade AI grades are deliberately not aggregated: they are opinions, and the audit
// showed them tracking rule-conformity more than entry quality.

const { toUtcMs, nySessionDate, nyParts, minutesFromRthOpen } = require('./time');
const { getPointValue } = require('./groupTrades');
const { STOPS, TARGETS } = require('./execution');

const num = v => (v == null || v === '' ? null : parseFloat(v));
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = a => { const v = a.filter(x => x != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };

const entryMs = t => toUtcMs(t.entry_time);
// The NY session a trade belongs to. A Sydney calendar date can hold two of these.
const sessionOf = t => (t.entry_time ? nySessionDate(entryMs(t)) : String(t.trade_date).slice(0, 10));
const holdSeconds = t => {
  const a = toUtcMs(t.entry_time), b = toUtcMs(t.exit_time);
  return a != null && b != null ? Math.max(0, Math.round((b - a) / 1000)) : null;
};
const tagNames = t => (t.tags || []).map(g => (g.group_name ? `${g.group_name}/${g.name}` : g.name));

// P&L stats over a set of trades. Shared by every bucket so headline and breakdowns agree.
function pnlStats(trades) {
  const closed = trades.filter(t => num(t.net_pnl) != null);
  const nets = closed.map(t => num(t.net_pnl));
  const wins = nets.filter(n => n > 0), losses = nets.filter(n => n < 0);
  const grossWin = sum(wins, n => n), grossLoss = Math.abs(sum(losses, n => n));
  return {
    trades: trades.length, closed: closed.length, open: trades.length - closed.length,
    wins: wins.length, losses: losses.length, scratches: nets.filter(n => n === 0).length,
    win_rate: pct(wins.length, closed.length),
    net: round2(sum(nets, n => n)),
    gross_win: round2(grossWin), gross_loss: round2(grossLoss),
    profit_factor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    expectancy: closed.length ? round2(sum(nets, n => n) / closed.length) : null,
    avg_win: wins.length ? round2(grossWin / wins.length) : null,
    avg_loss: losses.length ? round2(-grossLoss / losses.length) : null,
    best: nets.length ? round2(Math.max(...nets)) : null,
    worst: nets.length ? round2(Math.min(...nets)) : null,
    commission: round2(sum(trades, t => num(t.commission))),
  };
}

// Measured read quality for a group: of trades where direction was decided (price travelled
// two normal minutes' range one way first), how often it was the trader's way.
function reads(trades, exec) {
  let right = 0, wrong = 0;
  for (const t of trades) {
    const v = exec[t.id] && exec[t.id].direction_verdict;
    if (v === 'correct') right++; else if (v === 'incorrect') wrong++;
  }
  return { reads_decided: right + wrong, reads_right_pct: right + wrong ? pct(right, right + wrong) : null };
}

function bucket(trades, keyFn, { sortBy = 'net', asc = true } = {}, exec = {}) {
  const groups = new Map();
  for (const t of trades) {
    for (const k of [].concat(keyFn(t))) {
      if (k == null || k === '') continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
  }
  return [...groups.entries()].map(([key, ts]) => ({ key, ...pnlStats(ts), ...reads(ts, exec) }))
    .sort((a, b) => (asc ? a[sortBy] - b[sortBy] : b[sortBy] - a[sortBy]));
}

function streaks(trades) {
  let w = 0, l = 0, maxW = 0, maxL = 0;
  for (const t of [...trades].sort((a, b) => entryMs(a) - entryMs(b))) {
    const n = num(t.net_pnl);
    if (n == null || n === 0) continue;
    if (n > 0) { w++; l = 0; maxW = Math.max(maxW, w); } else { l++; w = 0; maxL = Math.max(maxL, l); }
  }
  return { max_win_streak: maxW, max_loss_streak: maxL };
}

// Trades opened within `withinMin` of closing a loss — the revenge-trade signature.
function afterLoss(trades, withinMin = 5) {
  const ordered = trades.filter(t => t.entry_time).sort((a, b) => entryMs(a) - entryMs(b));
  const flagged = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], prevExit = toUtcMs(prev.exit_time);
    if (prevExit == null || num(prev.net_pnl) >= 0) continue;
    const gap = (entryMs(ordered[i]) - prevExit) / 60000;
    if (gap >= 0 && gap <= withinMin) flagged.push(ordered[i]);
  }
  return { within_min: withinMin, ...pnlStats(flagged) };
}

function sessions(trades) {
  const days = bucket(trades, sessionOf);
  const band = n => (n <= 2 ? '1-2 trades' : n <= 5 ? '3-5 trades' : n <= 10 ? '6-10 trades' : '11+ trades');
  const byLoad = new Map();
  for (const d of days) { const k = band(d.trades); if (!byLoad.has(k)) byLoad.set(k, []); byLoad.get(k).push(d); }
  return {
    days: days.length,
    green_days: days.filter(d => d.net > 0).length,
    red_days: days.filter(d => d.net < 0).length,
    best_day: days.length ? days[days.length - 1] : null,
    worst_day: days.length ? days[0] : null,
    avg_trades_per_day: days.length ? round2(sum(days, d => d.trades) / days.length) : null,
    by_load: [...byLoad.entries()].map(([key, ds]) => ({
      key, days: ds.length,
      avg_trades: round2(sum(ds, d => d.trades) / ds.length),
      avg_day_net: round2(sum(ds, d => d.net) / ds.length),
      total_net: round2(sum(ds, d => d.net)),
    })).sort((a, b) => a.avg_trades - b.avg_trades),
  };
}

// Aggregate the measured execution metrics. `exec` = { trade_id: metrics }.
function execution(trades, exec) {
  const measured = trades.filter(t => exec[t.id] && num(t.net_pnl) != null);
  if (!measured.length) return { measured: 0, of: trades.length };
  const M = t => exec[t.id];
  const losers = measured.filter(t => num(t.net_pnl) < 0);
  const winners = measured.filter(t => num(t.net_pnl) > 0);
  const dir = { correct: 0, partial: 0, incorrect: 0 };
  for (const t of measured) dir[M(t).direction_verdict]++;
  const decided = dir.correct + dir.incorrect;

  // What fixed brackets on the SAME entries, size and fees would have produced, in dollars.
  const dollars = (t, ticks) => ticks * M(t).tick * getPointValue(t.instrument) * (t.quantity || 1);
  const fees = sum(measured, t => num(t.commission));
  const actual = round2(sum(measured, t => num(t.net_pnl)));
  const grid = [];
  for (const s of STOPS) for (const tg of TARGETS) {
    const key = `${s}x${tg}`;
    const outcomes = measured.map(t => M(t).grid[key]);
    grid.push({
      stop_ticks: s, target_ticks: tg,
      net: round2(sum(measured, t => dollars(t, M(t).grid[key])) - fees),
      win_rate: pct(outcomes.filter(o => o >= tg).length, outcomes.length),
    });
  }
  const best = grid.reduce((a, b) => (b.net > a.net ? b : a), grid[0]);
  const tickPts = median(measured.map(t => M(t).tick));

  return {
    measured: measured.length, of: trades.length,
    tick_pts: tickPts,
    noise_1m: median(measured.map(t => M(t).noise_1m)),
    losers: losers.length,
    stop_median: median(losers.map(t => M(t).stop_pts)),
    stop_vs_noise_median: median(losers.map(t => M(t).stop_vs_noise)),
    losers_inside_noise: losers.filter(t => M(t).stop_vs_noise < 1).length,
    direction: { ...dir, decided, correct_pct: pct(dir.correct, decided) },
    // Of losers whose direction was measured correct: the idea was right, the trade still lost.
    right_idea_losers: losers.filter(t => M(t).direction_verdict === 'correct').length,
    heat_before_peak_when_right: median(measured.filter(t => M(t).direction_verdict === 'correct').map(t => M(t).heat_before_peak)),
    winners: winners.length,
    capture_median: median(winners.map(t => M(t).capture)),
    captured_pts_median: median(winners.map(t => M(t).realized_pts)),
    available_pts_median: median(winners.map(t => M(t).mfe_15)),
    winners_under_third: winners.filter(t => M(t).capture < 1 / 3).length,
    actual_net: actual,
    grid, best,
    stops: STOPS, targets: TARGETS,
  };
}

const TIMING = ['Before the open', 'First 30 min', '30-60 min', '1-2 hours in', 'Later'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function summarize(trades, exec = {}) {
  const holds = trades.map(holdSeconds).filter(n => n != null);
  const hold = sel => { const h = trades.filter(sel).map(holdSeconds).filter(n => n != null); return h.length ? Math.round(sum(h, n => n) / h.length) : null; };
  return {
    overall: pnlStats(trades),
    hold_seconds: {
      avg: holds.length ? Math.round(sum(holds, n => n) / holds.length) : null,
      avg_win: hold(t => num(t.net_pnl) > 0),
      avg_loss: hold(t => num(t.net_pnl) < 0),
    },
    ...streaks(trades),
    execution: execution(trades, exec),
    by_instrument: bucket(trades, t => t.instrument, { asc: false }, exec),
    by_direction: bucket(trades, t => t.direction, { asc: false }, exec),
    // Half-hour buckets, so 09:30 (the cash open) never shares a row with pre-market 09:00.
    by_hour: bucket(trades, t => {
      if (!t.entry_time) return null;
      const p = nyParts(entryMs(t));
      return `${String(p.hour).padStart(2, '0')}:${p.minute < 30 ? '00' : '30'} ET`;
    }, {}, exec)
      .sort((a, b) => a.key.localeCompare(b.key)),
    by_timing: bucket(trades, t => {
      if (!t.entry_time) return null;
      const m = minutesFromRthOpen(entryMs(t));
      return m < 0 ? 'Before the open' : m < 30 ? 'First 30 min' : m < 60 ? '30-60 min' : m < 120 ? '1-2 hours in' : 'Later';
    }, {}, exec).sort((a, b) => TIMING.indexOf(a.key) - TIMING.indexOf(b.key)),
    by_dow: bucket(trades, t => DOW[new Date(sessionOf(t) + 'T12:00:00Z').getUTCDay()], {}, exec)
      .sort((a, b) => DOW.indexOf(a.key) - DOW.indexOf(b.key)),
    by_tag: bucket(trades, tagNames, {}, exec),
    after_loss: afterLoss(trades),
    day_stats: sessions(trades),
  };
}

module.exports = { summarize, pnlStats, holdSeconds, tagNames, sessionOf, num };
