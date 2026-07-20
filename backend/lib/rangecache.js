// Shared per-symbol range cache.
// Stores downloaded market-data ranges per symbol so overlapping trade windows
// only fetch the gaps that aren't already on disk. Works for ticks or candles.
const { pool } = require('../db');

// Return [s,e] sub-intervals NOT covered by the sorted `covered` ranges.
function gapsOf(s, e, covered) {
  const gaps = [];
  let cur = s;
  for (const [a, b] of covered) {
    if (b <= cur) continue;
    if (a >= e) break;
    if (a > cur) gaps.push([cur, Math.min(a, e)]);
    cur = Math.max(cur, b);
    if (cur >= e) break;
  }
  if (cur < e) gaps.push([cur, e]);
  return gaps;
}

async function coverage(table, symbol) {
  const { rows } = await pool.query(
    `SELECT start_ms, end_ms FROM ${table} WHERE symbol = $1 ORDER BY start_ms`, [symbol]);
  return rows.map(r => [Number(r.start_ms), Number(r.end_ms)]);
}

// Is [s,e] fully on disk already?
async function isCovered(table, symbol, s, e) {
  return gapsOf(s, e, await coverage(table, symbol)).length === 0;
}

async function evict(table, capBytes) {
  const { rows: [{ total }] } = await pool.query(`SELECT COALESCE(SUM(bytes),0)::bigint AS total FROM ${table}`);
  let used = Number(total);
  while (used > capBytes) {
    const { rows } = await pool.query(`SELECT id, bytes FROM ${table} ORDER BY created_at ASC LIMIT 1`);
    if (!rows.length) break;
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [rows[0].id]);
    used -= rows[0].bytes;
  }
}

// Ensure [s,e] is downloaded: fetch only the missing gaps via fetchFn(gapStart, gapEnd)
// -> { records, cost }. Records that fall in a gap are stored as a new range.
// Returns total cost + records fetched THIS call (0 if already fully cached).
async function ensureCoverage(table, symbol, s, e, fetchFn, capBytes) {
  const gaps = gapsOf(s, e, await coverage(table, symbol));
  let cost = 0, fetched = 0;
  for (const [gs, ge] of gaps) {
    const { records, cost: c } = await fetchFn(gs, ge);
    cost += (c || 0);
    fetched += records.length;
    const json = JSON.stringify(records);
    await pool.query(
      `INSERT INTO ${table} (symbol, start_ms, end_ms, records, bytes) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [symbol, gs, ge, json, Buffer.byteLength(json, 'utf8')]);
  }
  if (gaps.length) await evict(table, capBytes);
  return { cost, fetched, gaps: gaps.length };
}

// Read all records (ticks/candles) whose t is in [s,e), merged + sorted.
async function readRange(table, symbol, s, e) {
  const { rows } = await pool.query(
    `SELECT records FROM ${table} WHERE symbol = $1 AND end_ms > $2 AND start_ms < $3 ORDER BY start_ms`,
    [symbol, s, e]);
  const out = [];
  for (const r of rows) for (const rec of r.records) if (rec.t >= s && rec.t < e) out.push(rec);
  out.sort((a, b) => a.t - b.t);
  return out;
}

module.exports = { ensureCoverage, readRange, isCovered };
