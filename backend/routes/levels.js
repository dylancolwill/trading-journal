const express = require('express');
const { pool } = require('../db');
const { parseLevels } = require('../lib/parseLevels');
const { toText, toCsv } = require('../lib/formatLevels');
const { baseSymbol, sameFamily } = require('../lib/symbols');
const router = express.Router();

const LOCAL_TZ = process.env.TRADE_TZ || 'Australia/Sydney';

// Interpret a "YYYY-MM-DD HH:MM" wall-clock string in LOCAL_TZ as true UTC ms.
function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(tsStr.replace(' ', 'T') + 'Z');
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  return new Date(ref.getTime() + (utcDate.getTime() - tzDate.getTime()));
}
function toMs(str) { return str ? wallTimeToUtc(str, LOCAL_TZ).getTime() : null; }

// Attach UTC-ms timestamps (from LOCAL_TZ wall-clock) so charts can place time-anchored objects.
function withMs(obj) {
  const o = { ...obj };
  if (obj.at) o.ts = toMs(obj.at);
  if (obj.at1) o.ts1 = toMs(obj.at1);
  if (obj.at2) o.ts2 = toMs(obj.at2);
  return o;
}

// GET /api/levels?date=YYYY-MM-DD  -> all instrument rows saved for that day
router.get('/', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required' });
    const { rows } = await pool.query(
      `SELECT id, session_date, trade_date, instrument, raw_text, levels, updated_at
       FROM day_levels WHERE session_date = $1 ORDER BY instrument`,
      [date]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/levels/dates -> which trading days have levels saved (for UI highlighting)
router.get('/dates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT session_date AS trade_date, COUNT(*)::int AS instruments,
              COALESCE(SUM(jsonb_array_length(levels)), 0)::int AS objects
       FROM day_levels GROUP BY session_date`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/levels/for-trade/:tradeId -> parsed objects (with UTC ms) matching the trade's day + instrument
router.get('/for-trade/:tradeId', async (req, res) => {
  try {
    const { rows: [trade] } = await pool.query(
      'SELECT trade_date, session_date, instrument FROM trades WHERE id = $1', [req.params.tradeId]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    const base = baseSymbol(trade.instrument);
    // Exact NY session match. A Sydney calendar date can hold two NY sessions, so matching on
    // the stored date (even ±1 day) hands trades the wrong session's levels. The instrument
    // only has to be the same price series — charting ES while executing MES is normal and the
    // micro prints the same prices — so the whole family matches, exact ticker breaking ties.
    const { rows } = await pool.query(
      'SELECT levels, session_date, instrument FROM day_levels WHERE session_date = $1',
      [trade.session_date]);
    const [row] = rows
      .filter(r => sameFamily(r.instrument, base))
      .sort((a, b) => (baseSymbol(a.instrument) === base ? 0 : 1) - (baseSymbol(b.instrument) === base ? 0 : 1));
    const objects = row ? (row.levels || []).map(withMs) : [];
    res.json({
      instrument: base, date: trade.trade_date, session_date: trade.session_date, objects,
      matched_date: row ? row.session_date : null,
      matched_instrument: row ? row.instrument : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/levels/export?date=YYYY-MM-DD[&instrument=ES][&format=txt|csv]
// Saved levels back out as text (re-importable here) or CSV (for a NinjaTrader-side importer).
router.get('/export', async (req, res) => {
  try {
    const { date, instrument, format } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required' });
    const base = instrument ? baseSymbol(instrument) : null;
    const { rows: all } = await pool.query(
      `SELECT session_date AS trade_date, instrument, levels FROM day_levels
       WHERE session_date = $1 ORDER BY instrument`,
      [date]);
    // Asking for MES returns the ES set — same price series, same levels.
    const rows = base ? all.filter(r => sameFamily(r.instrument, base)) : all;
    if (!rows.length) return res.status(404).json({ error: 'No levels saved for that day' });

    const csv = String(format || 'txt').toLowerCase() === 'csv';
    const name = `levels-${date}${base ? '-' + base : ''}.${csv ? 'csv' : 'txt'}`;
    res.setHeader('Content-Type', `${csv ? 'text/csv' : 'text/plain'}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv ? toCsv(rows) : toText(rows, LOCAL_TZ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/levels  body { raw_text }  -> parse + upsert by (date, instrument)
router.post('/', async (req, res) => {
  try {
    const raw = req.body && req.body.raw_text;
    if (!raw || !raw.trim()) return res.status(400).json({ error: 'raw_text required' });
    const parsed = parseLevels(raw);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    // A paste can contain several instrument blocks — save each under its own instrument.
    const blocks = parsed.blocks.filter(b => b.objects.length);
    if (!blocks.length) return res.status(400).json({ error: 'No levels/zones/trends found in the text' });

    // Levels bind to a NY SESSION, not a calendar date. The caller names the session (the
    // button knows which session's trades it sits next to); the header date is a fallback,
    // and is often the export date rather than the session.
    const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
    const session = ymd(req.body && req.body.session_date) || ymd(req.body && req.body.trade_date);
    const importedOn = ymd(req.body && req.body.trade_date) || session;

    const saved = [];
    for (const b of blocks) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO day_levels (session_date, trade_date, instrument, raw_text, levels)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (session_date, instrument)
         DO UPDATE SET raw_text = EXCLUDED.raw_text, levels = EXCLUDED.levels,
                       trade_date = EXCLUDED.trade_date, updated_at = NOW()
         RETURNING id, session_date, trade_date, instrument, raw_text, levels, updated_at`,
        [session || b.date, importedOn || b.date, b.base, b.raw, JSON.stringify(b.objects)]);
      saved.push(row);
    }
    // Lines we could not read are reported rather than dropped in silence — an exporter
    // that changes shape should be visible immediately, not as missing objects later.
    const skipped = parsed.blocks.flatMap(b => b.skipped || []);
    res.json({ saved, count: saved.length, skipped_count: skipped.length, skipped: skipped.slice(0, 5) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/levels/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM day_levels WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
