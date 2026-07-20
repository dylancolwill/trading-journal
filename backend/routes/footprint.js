const express = require('express');
const { pool } = require('../db');
const { ensureCoverage, readRange, isCovered } = require('../lib/rangecache');
const router = express.Router();

const DB_KEY     = process.env.DATABENTO_API_KEY || '';
const DATASET    = 'GLBX.MDP3';
const HIST_URL   = 'https://hist.databento.com/v0';
const PRICE_SCALE = 1e9;          // Databento fixed-point price scale
const PAD_MIN    = 20;            // minutes of context before entry / after exit
const CACHE_CAP  = 50 * 1024 * 1024; // 50 MB total tick cache

// Local timezone for NT imports (DST handled automatically via Intl).
const LOCAL_TZ = process.env.TRADE_TZ || 'Australia/Sydney';

// Interpret a wall-clock string in `tz` and return the true UTC instant.
// Compares the UTC vs tz renderings of a reference instant so it works
// regardless of the server's own timezone (which here is also Sydney).
function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(tsStr.replace(' ', 'T') + 'Z');           // wall components as if UTC
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  const offset = utcDate.getTime() - tzDate.getTime();           // server-tz independent
  return new Date(ref.getTime() + offset);
}

// All stored trade times are Sydney wall-clock; convert to true UTC for Databento.
function toUtc(tsStr) {
  if (!tsStr) return null;
  return wallTimeToUtc(tsStr, LOCAL_TZ);
}

// "6E SEP26" / "ES" / "MNQ" -> continuous front month "6E.c.0"
function continuousSymbol(instrument) {
  const base = String(instrument || '').trim().split(/\s+/)[0].toUpperCase();
  return `${base}.c.0`;
}

// CME month codes
const MON_CODE = { 1:'F',2:'G',3:'H',4:'J',5:'K',6:'M',7:'N',8:'Q',9:'U',10:'V',11:'X',12:'Z' };
const MON_NAME = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

// "6E SEP26" or "6E 09-26" -> Databento Globex raw symbol "6EU6"
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
  if (!code) return null;
  return `${base}${code}${yy[1]}`; // CME Globex single-digit year, e.g. 6EU6
}

// For instruments with no contract month specified, infer the quarterly front-month
// from the trade date. Roll cutoff is ~day 15 of the expiry month (CME IMM approx).
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
  return `${base}H${String(yr + 1).slice(-1)}`; // past Dec expiry → March next year
}

// Pick the best Databento symbol + stype for a trade
function resolveSymbol(trade) {
  const raw = contractToRaw(trade.contract);
  if (raw) return { symbol: raw, stype: 'raw_symbol' };
  const inferred = inferRawSymbol(trade.instrument, trade.entry_time);
  if (inferred) return { symbol: inferred, stype: 'raw_symbol' };
  return { symbol: continuousSymbol(trade.instrument), stype: 'continuous' };
}

function authHeader() {
  return 'Basic ' + Buffer.from(DB_KEY + ':').toString('base64');
}

async function databentoGetCost(params) {
  const r = await fetch(`${HIST_URL}/metadata.get_cost`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!r.ok) return 0;
  const v = await r.json();
  return typeof v === 'number' ? v : (v.cost || 0);
}

async function databentoTrades({ symbol, stype, start, end }) {
  const params = {
    dataset: DATASET, symbols: symbol, stype_in: stype || 'continuous',
    schema: 'trades', start, end, encoding: 'json',
  };
  const cost = await databentoGetCost(params);
  const r = await fetch(`${HIST_URL}/timeseries.get_range`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!r.ok) {
    const body = await r.text();
    if (/available_end|data_end_after_available|dataset_unavailable_range/.test(body)) {
      const e = new Error('Market data for this date is not available yet (Databento has roughly a 1-day lag). Try again later.');
      e.status = 409;
      throw e;
    }
    throw new Error(`Databento ${r.status}: ${body}`);
  }
  const text = await r.text();
  const ticks = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    ticks.push({
      t: Math.floor(Number(BigInt(j.hd.ts_event) / 1000000n)), // ns -> ms
      price: Number(j.price) / PRICE_SCALE,
      size: j.size,
      side: j.side, // Databento: 'A' = sell aggressor (bid vol), 'B' = buy aggressor (ask vol), 'N' none
    });
  }
  return { ticks, cost };
}

// Aggregate raw ticks into time-bar x price-level footprint
function aggregate(ticks, barSeconds, tickSize) {
  const barMs = barSeconds * 1000;
  const grid = {}; // barTs -> { price -> [bid, ask] }
  const priceSet = new Set();
  for (const tk of ticks) {
    const bar = Math.floor(tk.t / barMs) * barMs;
    const price = Math.round(tk.price / tickSize) * tickSize;
    const key = price.toFixed(8);
    priceSet.add(key);
    if (!grid[bar]) grid[bar] = {};
    if (!grid[bar][key]) grid[bar][key] = [0, 0];
    // Databento side: 'A' = sell aggressor (traded at bid), 'B' = buy aggressor (traded at ask)
    if (tk.side === 'A') grid[bar][key][0] += tk.size;       // [0] = bid volume (sells)
    else if (tk.side === 'B') grid[bar][key][1] += tk.size;  // [1] = ask volume (buys)
  }
  const bars = Object.keys(grid).map(Number).sort((a, b) => a - b)
    .map(ts => ({ ts, cells: grid[ts] }));
  const prices = [...priceSet].map(Number).sort((a, b) => a - b);
  return { bars, prices };
}

// Guess tick size from price granularity in the data
function guessTickSize(ticks) {
  // common futures: 6E=0.00005, ES=0.25, NQ=0.25, etc. Derive from distinct prices.
  const diffs = new Set();
  const prices = [...new Set(ticks.map(t => +t.price.toFixed(8)))].sort((a, b) => a - b);
  for (let i = 1; i < prices.length && i < 200; i++) diffs.add(+(prices[i] - prices[i - 1]).toFixed(8));
  const min = [...diffs].filter(d => d > 0).sort((a, b) => a - b)[0];
  return min || 0.00005;
}

function buildResponse(ticks, symbol, cost, barSeconds, trade) {
  const tickSize = guessTickSize(ticks);
  const { bars, prices } = aggregate(ticks, barSeconds, tickSize);
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
    tick_count: ticks.length,
    cost: Number(cost) || 0,
    tick_size: tickSize,
    bar_seconds: barSeconds,
    // bar/marker timestamps are true UTC ms; label them in Sydney to match stored times
    display_tz: LOCAL_TZ,
    markers,
    bars, prices,
    ticks, // raw ticks for client-side replay
  };
}

// Resolve a trade -> { symbol, stype, startMs, endMs } window, or null
async function tradeWindow(tradeId) {
  const { rows: [trade] } = await pool.query(
    'SELECT id, instrument, contract, entry_time, exit_time, entry_price, exit_price, direction, source FROM trades WHERE id = $1', [tradeId]);
  if (!trade) return null;
  const entry = toUtc(trade.entry_time);
  if (!entry) return { trade, err: 'Trade has no entry_time' };
  const exit = toUtc(trade.exit_time) || new Date(entry.getTime() + 15 * 60000);
  const startMs = entry.getTime() - PAD_MIN * 60000;
  const endMs = exit.getTime() + PAD_MIN * 60000;
  const { symbol, stype } = resolveSymbol(trade);
  return { trade, symbol, stype, startMs, endMs };
}

// GET: return footprint only if the window is already downloaded (no new pull)
router.get('/:tradeId', async (req, res) => {
  try {
    const barSeconds = parseInt(req.query.bar || '300', 10);
    const w = await tradeWindow(req.params.tradeId);
    if (!w) return res.status(404).json({ error: 'Trade not found' });
    if (w.err || !(await isCovered('tick_ranges', w.symbol, w.startMs, w.endMs))) {
      return res.json({ cached: false });
    }
    const ticks = await readRange('tick_ranges', w.symbol, w.startMs, w.endMs);
    res.json(buildResponse(ticks, w.symbol, 0, barSeconds, w.trade));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: download only the missing gaps for this window, then return footprint
router.post('/:tradeId', async (req, res) => {
  try {
    if (!DB_KEY) return res.status(400).json({ error: 'DATABENTO_API_KEY not set on server' });
    const barSeconds = parseInt((req.body && req.body.bar) || '300', 10);
    const w = await tradeWindow(req.params.tradeId);
    if (!w) return res.status(404).json({ error: 'Trade not found' });
    if (w.err) return res.status(400).json({ error: w.err });

    const fetchFn = async (gs, ge) => {
      const { ticks, cost } = await databentoTrades({
        symbol: w.symbol, stype: w.stype,
        start: new Date(gs).toISOString().replace(/\.\d+Z$/, 'Z'),
        end: new Date(ge).toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      return { records: ticks, cost };
    };
    // force=true deletes overlapping cached ranges so the full window is re-fetched
    if (req.body && req.body.force) {
      await pool.query(
        `DELETE FROM tick_ranges WHERE symbol = $1 AND end_ms > $2 AND start_ms < $3`,
        [w.symbol, w.startMs, w.endMs]
      );
    }
    const { cost } = await ensureCoverage('tick_ranges', w.symbol, w.startMs, w.endMs, fetchFn, CACHE_CAP);
    const ticks = await readRange('tick_ranges', w.symbol, w.startMs, w.endMs);
    res.json(buildResponse(ticks, w.symbol, cost, barSeconds, w.trade));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
