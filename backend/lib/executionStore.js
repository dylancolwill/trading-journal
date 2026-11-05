// Persistence for per-trade execution metrics. Ticks are passed in by the caller (the
// footprint route owns tick loading), so this module has no route dependencies.

const { pool } = require('../db');
const { VERSION, computeExecution } = require('./execution');
const { toUtcMs } = require('./time');

// Compute from ticks and store. A measured row is never overwritten by a failed one: once
// ticks have been evicted a recompute can only fail, and the old numbers are still right.
async function saveExecution(trade, ticks) {
  const m = computeExecution(trade, ticks, toUtcMs(trade.entry_time), toUtcMs(trade.exit_time));
  if (m.covered) {
    await pool.query(
      `INSERT INTO trade_execution (trade_id, version, covered, metrics, computed_at)
       VALUES ($1, $2, true, $3::jsonb, NOW())
       ON CONFLICT (trade_id) DO UPDATE SET version = EXCLUDED.version, covered = true,
         metrics = EXCLUDED.metrics, computed_at = NOW()`,
      [trade.id, VERSION, JSON.stringify(m)]);
  } else {
    await markUnmeasured(trade.id, m);
  }
  return m;
}

// Record a failed check. Its time is what lets ensureExecution skip the trade until new ticks
// arrive; a row measured before its ticks were evicted is never downgraded.
async function markUnmeasured(tradeId, why = { covered: false, reason: 'ticks not cached' }) {
  await pool.query(
    `INSERT INTO trade_execution (trade_id, version, covered, metrics, computed_at) VALUES ($1, $2, false, $3::jsonb, NOW())
     ON CONFLICT (trade_id) DO UPDATE SET version = EXCLUDED.version, metrics = EXCLUDED.metrics, computed_at = NOW()
     WHERE trade_execution.covered = false`,
    [tradeId, VERSION, JSON.stringify(why)]);
}

// { trade_id: metrics } for measured trades only.
async function getExecution(ids) {
  if (!ids.length) return {};
  const { rows } = await pool.query(
    'SELECT trade_id, metrics FROM trade_execution WHERE covered AND trade_id = ANY($1)', [ids]);
  return Object.fromEntries(rows.map(r => [r.trade_id, r.metrics]));
}

// Fill in anything missing or computed under an older formula, for trades whose ticks are
// still cached. `loadTicks(id)` -> { trade, ticks } | null.
//
// An unmeasured trade is only re-checked if tick data has been downloaded since its last
// check — ticks can arrive through a neighbouring trade's overlapping window, but otherwise
// nothing about its coverage can have changed.
async function ensureExecution(ids, loadTicks) {
  if (!ids.length) return;
  const [{ rows }, { rows: [{ last_fetch }] }] = await Promise.all([
    pool.query('SELECT trade_id, version, covered, computed_at FROM trade_execution WHERE trade_id = ANY($1)', [ids]),
    pool.query('SELECT MAX(created_at) AS last_fetch FROM tick_ranges'),
  ]);
  const lastFetch = last_fetch ? new Date(last_fetch) : null;
  const settled = new Set(rows.filter(r => r.version >= VERSION &&
    (r.covered || (lastFetch && new Date(r.computed_at) >= lastFetch))).map(r => r.trade_id));
  for (const id of ids) {
    if (settled.has(id)) continue;
    try {
      const got = await loadTicks(id);
      if (got) await saveExecution(got.trade, got.ticks);
      else await markUnmeasured(id);
    } catch (e) { console.error(`[execution] trade ${id}:`, e.message); }
  }
}

module.exports = { saveExecution, getExecution, ensureExecution };
