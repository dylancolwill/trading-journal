// Objective, tick-exact execution metrics for one trade: what price actually did around the
// entry, measured in the instrument's own ticks. These are facts, not opinions — the AI
// reviewers are told to anchor their grades on them, and the AI Analysis page aggregates them.
//
// Pure: callers supply the ticks. Persisted per trade (trade_execution) because the tick
// cache evicts old ranges — once a trade's ticks are gone these numbers can't be recomputed.

const VERSION = 2;               // bump when a formula changes; stored rows below it are recomputed

const PRE_MS = 20 * 60000;       // pre-entry window used to measure normal 1-minute noise
const HORIZON_MS = 15 * 60000;   // post-entry window for excursions and the what-if grid
const DECIDE_MS = 10 * 60000;    // direction is decided within this long after entry
const STOPS = [4, 8, 12, 16, 24];     // what-if stop sizes, ticks (ES: 1, 2, 3, 4, 6 pts)
const TARGETS = [8, 12, 16, 24, 32];  // what-if targets, ticks  (ES: 2, 3, 4, 6, 8 pts)

// Smallest positive price increment observed (the instrument's tick size).
function guessTick(ticks) {
  const ps = [...new Set(ticks.map(t => +Number(t.price).toFixed(6)))].sort((a, b) => a - b);
  let m = Infinity;
  for (let i = 1; i < ps.length && i < 800; i++) { const d = +(ps[i] - ps[i - 1]).toFixed(6); if (d > 0 && d < m) m = d; }
  return isFinite(m) ? m : 0.25;
}

const median = a => { const v = [...a].sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
const r2 = n => (n == null ? null : Math.round(n * 100) / 100);

// Walk ticks in order; return which side of ±k (in price units) is reached first.
function firstTo(ticks, entry, sign, k, untilMs) {
  for (const t of ticks) {
    if (t.t > untilMs) break;
    const fav = sign * (t.price - entry);
    if (fav >= k - 1e-9) return 'for';
    if (-fav >= k - 1e-9) return 'against';
  }
  return 'neither';
}

// Outcome of a fixed stop/target bracket placed at the entry, in ticks: +target if it is hit
// first, -stop if that is, otherwise marked to market at the end of the horizon.
function bracket(ticks, entry, sign, tick, stopT, targetT, untilMs) {
  let last = entry;
  for (const t of ticks) {
    if (t.t > untilMs) break;
    const favT = sign * (t.price - entry) / tick;
    if (favT >= targetT - 1e-9) return targetT;
    if (-favT >= stopT - 1e-9) return -stopT;
    last = t.price;
  }
  return Math.round(sign * (last - entry) / tick);
}

// ticks: [{ t (UTC ms), price }] covering at least [entry-20m, entry+15m], any order.
function computeExecution({ direction, entry_price, exit_price }, allTicks, entryMs, exitMs) {
  const e = Number(entry_price);
  const sign = direction === 'LONG' ? 1 : -1;
  const ticks = [...allTicks].sort((a, b) => a.t - b.t);
  if (!ticks.length || !Number.isFinite(e) || entryMs == null) return { covered: false, reason: 'no ticks' };

  const endMs = Math.max(entryMs + HORIZON_MS, exitMs || 0);
  const first = ticks[0].t, last = ticks[ticks.length - 1].t;
  // Quiet tape can leave a gap at either edge; a couple of minutes' slack is still a fair read.
  if (first > entryMs - PRE_MS + 3 * 60000 || last < entryMs + HORIZON_MS - 2 * 60000) {
    return { covered: false, reason: 'tick window does not span entry-20m..entry+15m' };
  }
  const tick = guessTick(ticks);

  // Normal noise: median high-low of the 1-minute bars in the 20 minutes before entry.
  const minute = new Map();
  for (const t of ticks) {
    if (t.t < entryMs - PRE_MS || t.t >= entryMs) continue;
    const k = Math.floor(t.t / 60000);
    const b = minute.get(k) || { hi: -Infinity, lo: Infinity };
    b.hi = Math.max(b.hi, t.price); b.lo = Math.min(b.lo, t.price);
    minute.set(k, b);
  }
  const noise = median([...minute.values()].map(b => b.hi - b.lo)) || tick * 4;

  const post = ticks.filter(t => t.t >= entryMs && t.t <= endMs);
  const within = ms => post.filter(t => t.t <= entryMs + ms);
  const exc = arr => ({
    mfe: arr.length ? Math.max(0, ...arr.map(t => sign * (t.price - e))) : 0,
    mae: arr.length ? Math.max(0, ...arr.map(t => -sign * (t.price - e))) : 0,
  });
  const x5 = exc(within(5 * 60000));
  const x15 = exc(post);

  // Heat taken before the best price of the horizon was reached.
  let peakI = 0;
  post.forEach((t, i) => { if (sign * (t.price - e) > sign * (post[peakI].price - e)) peakI = i; });
  const heatBeforePeak = exc(post.slice(0, peakI + 1)).mae;

  const x = exit_price != null ? Number(exit_price) : null;
  const realized = x != null ? sign * (x - e) : null;

  // Direction: did price travel two normal minutes' range your way before it travelled that
  // far against you? A move inside one minute's range is noise by definition, so it can't
  // decide the read. Floor of 8 ticks so a dead tape can't decide it on a couple of ticks.
  const decideK = Math.max(2 * noise, 8 * tick);
  const decided = firstTo(post, e, sign, decideK, entryMs + DECIDE_MS);
  const direction_verdict = decided === 'for' ? 'correct' : decided === 'against' ? 'incorrect' : 'partial';

  const grid = {};
  for (const s of STOPS) for (const tg of TARGETS) grid[`${s}x${tg}`] = bracket(post, e, sign, tick, s, tg, entryMs + HORIZON_MS);

  return {
    covered: true,
    tick,
    noise_1m: r2(noise),
    realized_pts: r2(realized),
    stop_pts: realized != null && realized < 0 ? r2(-realized) : null,
    stop_vs_noise: realized != null && realized < 0 ? r2(-realized / noise) : null,
    mfe_5: r2(x5.mfe), mae_5: r2(x5.mae),
    mfe_15: r2(x15.mfe), mae_15: r2(x15.mae),
    heat_before_peak: r2(heatBeforePeak),
    capture: realized != null && realized > 0 ? r2(realized / Math.max(x15.mfe, realized)) : null,
    first_to: {
      8: firstTo(post, e, sign, 8 * tick, entryMs + HORIZON_MS),
      16: firstTo(post, e, sign, 16 * tick, entryMs + HORIZON_MS),
      24: firstTo(post, e, sign, 24 * tick, entryMs + HORIZON_MS),
    },
    decide_pts: r2(decideK),
    direction_verdict,
    grid,
    stops: STOPS, targets: TARGETS,
  };
}

// Plain-text block for the per-trade prompt. Everything here is measured, so it is framed as
// ground truth the review has to be consistent with.
const fmtSigned = v => `${v > 0 ? '+' : ''}${+v.toFixed(4)}`;

function executionBlock(m) {
  if (!m || !m.covered) return '';
  const pts = v => (v == null ? '–' : `${v} pts`);
  const firstTxt = k => ({ for: 'your way first', against: 'against you first', neither: 'neither reached' })[m.first_to[k]];
  const tk = m.tick;
  return `\n\n=== OBJECTIVE OUTCOME (measured tick-by-tick — facts, not opinion) ===
Normal noise: median 1-minute range in the 20 min before entry = ${pts(m.noise_1m)}
${m.stop_pts != null
    ? `Stop taken: ${pts(m.stop_pts)} = ${m.stop_vs_noise}× one normal minute's range${m.stop_vs_noise < 1 ? '  ← stop sat INSIDE ordinary 1-minute noise' : ''}`
    : `Result: +${pts(m.realized_pts)} captured of ${pts(m.mfe_15)} available within 15 min (${Math.round((m.capture || 0) * 100)}% capture)`}
First 5 min after entry: ${pts(m.mfe_5)} your way / ${pts(m.mae_5)} against
First 15 min after entry: ${pts(m.mfe_15)} your way / ${pts(m.mae_15)} against; heat taken before the best price: ${pts(m.heat_before_peak)}
Which came first: ${+(8 * tk).toFixed(6)} pts ${firstTxt(8)} · ${+(16 * tk).toFixed(6)} pts ${firstTxt(16)} · ${+(24 * tk).toFixed(6)} pts ${firstTxt(24)}
Same entry with a fixed stop/target instead (first hit within 15 min, else marked at 15 min): ${[[8, 16], [12, 24], [16, 32]].map(([st, tg]) => `stop ${+(st * tk).toFixed(6)} / target ${+(tg * tk).toFixed(6)} → ${fmtSigned(m.grid[`${st}x${tg}`] * tk)} pts`).join(' · ')}
Measured direction verdict: ${m.direction_verdict.toUpperCase()} (price ${m.direction_verdict === 'correct' ? 'reached' : m.direction_verdict === 'incorrect' ? 'went against by' : 'did not travel'} ${pts(m.decide_pts)} — two normal minutes' range — ${m.direction_verdict === 'partial' ? 'either way' : m.direction_verdict === 'correct' ? 'your way before against' : 'before going your way'} within 10 min)`;
}

module.exports = { VERSION, computeExecution, executionBlock, guessTick, STOPS, TARGETS };
