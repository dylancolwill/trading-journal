const express = require('express');
const { pool } = require('../db');
const { parseLevels } = require('../lib/parseLevels');
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

function baseSymbol(instrument) {
  return String(instrument || '').trim().split(/\s+/)[0].toUpperCase();
}

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
      'SELECT id, trade_date, instrument, raw_text, levels, updated_at FROM day_levels WHERE trade_date = $1 ORDER BY instrument',
      [date]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/levels/dates -> which trading days have levels saved (for UI highlighting)
router.get('/dates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT trade_date, COUNT(*)::int AS instruments,
              COALESCE(SUM(jsonb_array_length(levels)), 0)::int AS objects
       FROM day_levels GROUP BY trade_date`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/levels/for-trade/:tradeId -> parsed objects (with UTC ms) matching the trade's day + instrument
router.get('/for-trade/:tradeId', async (req, res) => {
  try {
    const { rows: [trade] } = await pool.query(
      'SELECT trade_date, instrument FROM trades WHERE id = $1', [req.params.tradeId]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    const base = baseSymbol(trade.instrument);
    // Match the same instrument, nearest session date within ±1 day. Trade dates are
    // stored in local time, so a level set exported for one session can land on the
    // adjacent calendar day; instrument still has to match (price scales never cross).
    const { rows: [row] } = await pool.query(
      `SELECT levels, trade_date FROM day_levels
       WHERE instrument = $2 AND trade_date BETWEEN $1::date - 1 AND $1::date + 1
       ORDER BY ABS(trade_date - $1::date) ASC
       LIMIT 1`,
      [trade.trade_date, base]);
    const objects = row ? (row.levels || []).map(withMs) : [];
    res.json({ instrument: base, date: trade.trade_date, matched_date: row ? row.trade_date : null, objects });
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

    // Levels bind to the day the user imported for (the button's day) — the authoritative
    // session date. The header date is often just an export date.
    const override = req.body && req.body.trade_date;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(override || '') ? override : null;

    const saved = [];
    for (const b of blocks) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO day_levels (trade_date, instrument, raw_text, levels)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (trade_date, instrument)
         DO UPDATE SET raw_text = EXCLUDED.raw_text, levels = EXCLUDED.levels, updated_at = NOW()
         RETURNING id, trade_date, instrument, raw_text, levels, updated_at`,
        [date || b.date, b.base, b.raw, JSON.stringify(b.objects)]);
      saved.push(row);
    }
    res.json({ saved, count: saved.length });
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
