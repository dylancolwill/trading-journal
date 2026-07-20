const express = require('express');
const { pool } = require('../db');
const { ensureCoverage, readRange, isCovered } = require('../lib/rangecache');
const router = express.Router();

const DB_KEY    = process.env.DATABENTO_API_KEY || '';
const DATASET   = 'GLBX.MDP3';
const HIST_URL  = 'https://hist.databento.com/v0';
const PRICE_SCALE = 1e9;
const PAD_BEFORE_MIN = 90;   // 1.5 hours before entry
const PAD_AFTER_MIN  = 90;   // 1.5 hours after exit
const CACHE_CAP = 20 * 1024 * 1024; // 20 MB (candles are tiny)
const LOCAL_TZ  = process.env.TRADE_TZ || 'Australia/Sydney';

function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(tsStr.replace(' ', 'T') + 'Z');
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  return new Date(ref.getTime() + (utcDate.getTime() - tzDate.getTime()));
}
function toUtc(tsStr) { return tsStr ? wallTimeToUtc(tsStr, LOCAL_TZ) : null; }

const MON_CODE = { 1:'F',2:'G',3:'H',4:'J',5:'K',6:'M',7:'N',8:'Q',9:'U',10:'V',11:'X',12:'Z' };
const MON_NAME = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
function contractToRaw(contract) {
  if (!contract) return null;
  const parts = String(contract).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const base = parts[0].toUpperCase();
  const rest = parts.slice(1).join('');
  let mon, yy, m;
  if ((m = rest.match(/^([A-Za-z]{3})(\d{2})$/))) { mon = MON_NAME[m[1].toUpperCase()]; yy = m[2]; }
  else if ((m = rest.match(/^(\d{1,2})-(\d{2})$/))) { mon = parseInt(m[1], 10); yy = m[2]; }
  else return null;
  const code = MON_CODE[mon];
  return code ? `${base}${code}${yy[1]}` : null;
}
const QUARTERLY = [[3,'H'],[6,'M'],[9,'U'],[12,'Z']];
function inferRawSymbol(instrument, entryTime) {
  if (!entryTime) return null;
  const base = String(instrument).trim().split(/\s+/)[0].toUpperCase();
  const m = entryTime.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, yr, mo, day] = m.map(Number);
  for (const [qMo, code] of QUARTERLY) {
    if (qMo > mo || (qMo === mo && day < 15))
      return `${base}${code}${String(yr).slice(-1)}`;
  }
  return `${base}H${String(yr + 1).slice(-1)}`;
}

function resolveSymbol(trade) {
  const raw = contractToRaw(trade.contract);
  if (raw) return { symbol: raw, stype: 'raw_symbol' };
  const inferred = inferRawSymbol(trade.instrument, trade.entry_time);
  if (inferred) return { symbol: inferred, stype: 'raw_symbol' };
  const base = String(trade.instrument || '').trim().split(/\s+/)[0].toUpperCase();
  return { symbol: `${base}.c.0`, stype: 'continuous' };
}
function authHeader() { return 'Basic ' + Buffer.from(DB_KEY + ':').toString('base64'); }

async function databentoCandles({ symbol, stype, start, end }) {
  const params = { dataset: DATASET, symbols: symbol, stype_in: stype || 'continuous',
    schema: 'ohlcv-1m', start, end, encoding: 'json' };
  // cost estimate
  let cost = 0;
  try {
    const cr = await fetch(`${HIST_URL}/metadata.get_cost`, {
      method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params) });
    if (cr.ok) { const v = await cr.json(); cost = typeof v === 'number' ? v : (v.cost || 0); }
  } catch (e) {}

  const r = await fetch(`${HIST_URL}/timeseries.get_range`, {
    method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params) });
  if (!r.ok) {
    const body = await r.text();
    if (/available_end|data_end_after_available|dataset_unavailable_range/.test(body)) {
      const e = new Error('Market data for this date is not available yet (Databento has roughly a 1-day lag). Try again later.');
      e.status = 409; throw e;
    }
    throw new Error(`Databento ${r.status}: ${body}`);
  }
  const text = await r.text();
  const candles = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    candles.push({
      t: Math.floor(Number(BigInt(j.hd.ts_event) / 1000000n)),
      o: Number(j.open) / PRICE_SCALE,
      h: Number(j.high) / PRICE_SCALE,
      l: Number(j.low) / PRICE_SCALE,
      c: Number(j.close) / PRICE_SCALE,
      v: Number(j.volume),
    });
  }
  return { candles, cost };
}

function buildResponse(candles, symbol, cost, trade) {
  let markers = null;
  if (trade) {
    const entryUtc = toUtc(trade.entry_time);
    const exitUtc = toUtc(trade.exit_time);
    markers = {
      entry: entryUtc ? { ts: entryUtc.getTime(), price: Number(trade.entry_price) } : null,
      exit: exitUtc && trade.exit_price != null ? { ts: exitUtc.getTime(), price: Number(trade.exit_price) } : null,
      direction: trade.direction,
    };
  }
  return {
    cached: true,
    symbol,
    cost: Number(cost) || 0,
    display_tz: LOCAL_TZ,
    markers,
    candles,
  };
}

async function tradeWindow(tradeId) {
  const { rows: [trade] } = await pool.query(
    'SELECT id, instrument, contract, entry_time, exit_time, entry_price, exit_price, direction, source FROM trades WHERE id = $1', [tradeId]);
  if (!trade) return null;
  const entry = toUtc(trade.entry_time);
  if (!entry) return { trade, err: 'Trade has no entry_time' };
  const exit = toUtc(trade.exit_time) || new Date(entry.getTime() + 15 * 60000);
  const startMs = entry.getTime() - PAD_BEFORE_MIN * 60000;
  const endMs = exit.getTime() + PAD_AFTER_MIN * 60000;
  const { symbol, stype } = resolveSymbol(trade);
  return { trade, symbol, stype, startMs, endMs };
}

router.get('/:tradeId', async (req, res) => {
  try {
    const w = await tradeWindow(req.params.tradeId);
    if (!w) return res.status(404).json({ error: 'Trade not found' });
    if (w.err || !(await isCovered('candle_ranges', w.symbol, w.startMs, w.endMs))) {
      return res.json({ cached: false });
    }
    const candles = await readRange('candle_ranges', w.symbol, w.startMs, w.endMs);
    res.json(buildResponse(candles, w.symbol, 0, w.trade));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:tradeId', async (req, res) => {
  try {
    if (!DB_KEY) return res.status(400).json({ error: 'DATABENTO_API_KEY not set on server' });
    const w = await tradeWindow(req.params.tradeId);
    if (!w) return res.status(404).json({ error: 'Trade not found' });
    if (w.err) return res.status(400).json({ error: w.err });

    const fetchFn = async (gs, ge) => {
      const { candles, cost } = await databentoCandles({
        symbol: w.symbol, stype: w.stype,
        start: new Date(gs).toISOString().replace(/\.\d+Z$/, 'Z'),
        end: new Date(ge).toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      return { records: candles, cost };
    };
    const { cost } = await ensureCoverage('candle_ranges', w.symbol, w.startMs, w.endMs, fetchFn, CACHE_CAP);
    const candles = await readRange('candle_ranges', w.symbol, w.startMs, w.endMs);
    res.json(buildResponse(candles, w.symbol, cost, w.trade));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
