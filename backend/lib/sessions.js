// Backfill trades.session_date — the NY session a trade belongs to.
// Runs at startup; only touches rows that don't have it yet, so it is cheap and idempotent.

const { pool } = require('../db');
const { nySessionDate, toUtcMs } = require('./time');

const sessionDateOf = trade => {
  const ms = toUtcMs(trade.entry_time);
  return ms == null ? null : nySessionDate(ms);
};

async function backfillSessionDates() {
  const { rows } = await pool.query(
    'SELECT id, entry_time FROM trades WHERE session_date IS NULL AND entry_time IS NOT NULL');
  for (const t of rows) {
    await pool.query('UPDATE trades SET session_date = $1 WHERE id = $2', [sessionDateOf(t), t.id]);
  }
  // Level sets imported before session keying existed: assume the date they were filed under.
  const { rowCount: lv } = await pool.query(
    'UPDATE day_levels SET session_date = trade_date WHERE session_date IS NULL');
  if (rows.length || lv) console.log(`[sessions] backfilled ${rows.length} trades, ${lv} level sets`);
  return { trades: rows.length, levels: lv };
}

module.exports = { backfillSessionDates, sessionDateOf };
