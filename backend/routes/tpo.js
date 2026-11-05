const express = require('express');
const { pool } = require('../db');
const { ensureCoverage, readRange, isCovered } = require('../lib/rangecache');
const { nySessionDate, rthOpenMs } = require('../lib/time');
const router = express.Router();

const DB_KEY    = process.env.DATABENTO_API_KEY || '';
const DATASET   = 'GLBX.MDP3';
const HIST_URL  = 'https://hist.databento.com/v0';
const PRICE_SCALE = 1e9;
const CACHE_CAP = 20 * 1024 * 1024; // 20 MB (shared candle_ranges cache)
const LOCAL_TZ  = process.env.TRADE_TZ || 'Australia/Sydney';

// TPO / Market Profile session config.
// Profile spans the full CME Globex session (17:00 CT -> 16:00 CT next day);
// the Initial Balance level is the London morning first hour inside that session.
const GLOBEX_TZ   = 'America/Chicago';
const OPEN_HHMM   = [17, 0];   // Globex open 17:00 CT (previous calendar day)
const CLOSE_HHMM  = [16, 0];   // Globex close 16:00 CT
const IB_TZ       = 'Europe/London';
const IB_OPEN     = [8, 0];    // London open 08:00
const IB_MINUTES  = 60;        // Initial Balance = first hour
const BRACKET_MIN = 30;        // 30-minute TPO brackets
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// ---- timezone helpers (interpret a wall-clock string in tz -> true UTC) ----
function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(tsStr.replace(' ', 'T') + 'Z');
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  return new Date(ref.getTime() + (utcDate.getTime() - tzDate.getTime()));
}
function toUtc(tsStr) { return tsStr ? wallTimeToUtc(tsStr, LOCAL_TZ) : null; }
// YYYY-MM-DD calendar date of an instant in a given tz
function dateStrIn(d, tz) { return d.toLocaleDateString('en-CA', { timeZone: tz }); }
// YYYY-MM-DD HH:MM:SS wall-clock of an instant in a given tz (sv-SE = ISO-like)
function wallStrIn(d, tz) { return d.toLocaleString('sv-SE', { timeZone: tz }); }
// pure calendar date arithmetic on a YYYY-MM-DD string
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const pad2 = n => String(n).padStart(2, '0');
function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sun … 6 = Sat
}
// Open date of the session before the one that opened on `openDate`. Globex runs
// Sun–Fri, so the day before a Sunday-open session is Saturday (no session) and the
// real previous session is Thursday's (Thu 17:00 CT -> Fri 16:00 CT).
function prevSessionOpenDate(openDate) {
  const back1 = shiftDate(openDate, -1);
  return dowOf(back1) === 6 ? shiftDate(openDate, -3) : back1;
}

// London initial-balance window (08:00–09:00 London) that falls inside [openMs, closeMs).
function londonIB(openMs, closeMs) {
  for (const anchor of [openMs, closeMs]) {
    const ld = dateStrIn(new Date(anchor), IB_TZ);
    const ibStart = wallTimeToUtc(`${ld} ${pad2(IB_OPEN[0])}:${pad2(IB_OPEN[1])}:00`, IB_TZ).getTime();
    if (ibStart >= openMs && ibStart < closeMs) return { ibStart, ibEnd: ibStart + IB_MINUTES * 60000 };
  }
  return null;
}

// ---- symbol resolution (same rules as candles/footprint routes) ----
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
      o: Number(j.open) / PRICE_SCALE, h: Number(j.high) / PRICE_SCALE,
      l: Number(j.low) / PRICE_SCALE, c: Number(j.close) / PRICE_SCALE, v: Number(j.volume),
    });
  }
  return { candles, cost };
}

// Pick a "nice" TPO row size so the profile is ~45 rows tall.
function niceRowSize(range) {
  if (!(range > 0)) return 1;
  const target = 45;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

// Build the market profile from 1-minute candles within [openMs, closeMs].
// The IB high/low is taken from candles in [ibStartMs, ibEndMs) (London morning).
// forceRowSize pins the price grid (used so the previous session shares today's rows).
function buildProfile(candles, openMs, closeMs, ibStartMs, ibEndMs, forceRowSize) {
  const inSession = candles
    .filter(c => c.t >= openMs && c.t < closeMs)
    .sort((a, b) => a.t - b.t);
  if (!inSession.length) return null;

  let hi = -Infinity, lo = Infinity;
  for (const c of inSession) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); }
  const rowSize = forceRowSize > 0 ? forceRowSize : niceRowSize(hi - lo);
  const decimals = Math.max(0, -Math.floor(Math.log10(rowSize)) );
  const kOf = (price) => Math.round(price / rowSize);

  // k -> Set of bracket letters
  const rowLetters = new Map();
  const bracketSet = new Set();
  let ibHi = -Infinity, ibLo = Infinity;
  for (const c of inSession) {
    const bi = Math.floor((c.t - openMs) / (BRACKET_MIN * 60000));
    const letter = LETTERS[bi] || '·';
    bracketSet.add(letter);
    const kLo = kOf(c.l), kHi = kOf(c.h);
    for (let k = kLo; k <= kHi; k++) {
      if (!rowLetters.has(k)) rowLetters.set(k, new Set());
      rowLetters.get(k).add(letter);
    }
    if (ibStartMs != null && c.t >= ibStartMs && c.t < ibEndMs) { ibHi = Math.max(ibHi, c.h); ibLo = Math.min(ibLo, c.l); }
  }

  const minK = kOf(lo), maxK = kOf(hi);
  const rows = [];
  let total = 0, pocIdx = 0, pocCount = -1;
  for (let k = maxK; k >= minK; k--) {           // high price first (top of profile)
    const set = rowLetters.get(k);
    const letters = set ? [...set].sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b)).join('') : '';
    const count = set ? set.size : 0;
    total += count;
    if (count > pocCount) { pocCount = count; pocIdx = rows.length; }
    rows.push({ price: k * rowSize, letters, count });
  }

  // Value area: expand out from POC until >= 70% of total TPOs (see finalizeProfile).
  const target = total * 0.7;
  return finalizeProfile(rows, pocIdx, total, target, {
    rowSize, decimals, hi, lo, ibHi, ibLo,
    brackets: [...bracketSet], openMs, closeMs, ibStartMs, ibEndMs,
  });
}

// Clean value-area expansion + assembly (kept separate for readability).
function finalizeProfile(rows, pocIdx, total, target, meta) {
  let vaSum = rows[pocIdx].count;
  let up = pocIdx - 1, down = pocIdx + 1; // up = higher price, down = lower price
  let vahIdx = pocIdx, valIdx = pocIdx;
  while (vaSum < target && (up >= 0 || down < rows.length)) {
    const upVal = up >= 0 ? rows[up].count : -1;
    const downVal = down < rows.length ? rows[down].count : -1;
    if (upVal >= downVal) { vaSum += upVal; vahIdx = up; up--; }
    else { vaSum += downVal; valIdx = down; down++; }
  }
  const poc = rows[pocIdx].price;
  const vah = rows[Math.min(vahIdx, valIdx)].price; // higher price
  const val = rows[Math.max(vahIdx, valIdx)].price; // lower price
  // TPO count: total TPOs above vs below the POC (POC row excluded).
  let tpoOver = 0, tpoUnder = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i < pocIdx) tpoOver += rows[i].count;        // rows are high -> low, so above POC
    else if (i > pocIdx) tpoUnder += rows[i].count;
  }
  return {
    rows,
    poc,
    va: { high: Math.max(vah, val), low: Math.min(vah, val) },
    ib: (meta.ibHi > -Infinity) ? { high: meta.ibHi, low: meta.ibLo } : null,
    session_high: meta.hi,
    session_low: meta.lo,
    total_tpo: total,
    tpo_over: tpoOver,
    tpo_under: tpoUnder,
    row_size: meta.rowSize,
    decimals: meta.decimals,
    bracket_count: meta.brackets.length,
    session: { open: meta.openMs, close: meta.closeMs, ib_start: meta.ibStartMs, ib_end: meta.ibEndMs },
  };
}

function buildResponse(candles, symbol, cost, w, trade, prevCandles) {
  const profile = buildProfile(candles, w.openMs, w.closeMs, w.ibStartMs, w.ibEndMs);
  // Prior session shares today's row size so both profiles sit on the same price grid.
  const prevProfile = prevCandles
    ? buildProfile(prevCandles, w.prevOpenMs, w.prevCloseMs, w.prevIbStartMs, w.prevIbEndMs,
        profile && profile.row_size)
    : null;
  let markers = null;
  if (trade) {
    markers = {
      entry: trade.entry_price != null ? { price: Number(trade.entry_price) } : null,
      exit: trade.exit_price != null ? { price: Number(trade.exit_price) } : null,
      direction: trade.direction,
    };
  }
  return {
    cached: true,
    symbol,
    cost: Number(cost) || 0,
    display_tz: LOCAL_TZ,
    session_tz: GLOBEX_TZ,
    markers,
    profile,
    prev_profile: prevProfile,
  };
}

// Resolve a trade -> Globex-session window { symbol, stype, openMs, closeMs, ibStartMs, ibEndMs }
async function tradeWindow(tradeId) {
  const { rows: [trade] } = await pool.query(
    'SELECT id, instrument, contract, trade_date, entry_time, exit_time, entry_price, exit_price, direction, source FROM trades WHERE id = $1', [tradeId]);
  if (!trade) return null;
  const entry = toUtc(trade.entry_time);
  if (!entry) return { trade, err: 'Trade has no entry_time' };
  // Globex session containing the entry: opens 17:00 CT, closes 16:00 CT the next day.
  // If the entry is before 17:00 CT it belongs to the session that opened the prior day.
  const ctWall = wallStrIn(entry, GLOBEX_TZ);            // "YYYY-MM-DD HH:MM:SS"
  const ctDate = ctWall.slice(0, 10);
  const ctHour = Number(ctWall.slice(11, 13));
  const openDate = ctHour >= OPEN_HHMM[0] ? ctDate : shiftDate(ctDate, -1);
  const closeDate = shiftDate(openDate, 1);
  const openMs = wallTimeToUtc(`${openDate} ${pad2(OPEN_HHMM[0])}:${pad2(OPEN_HHMM[1])}:00`, GLOBEX_TZ).getTime();
  const sessionCloseMs = wallTimeToUtc(`${closeDate} ${pad2(CLOSE_HHMM[0])}:${pad2(CLOSE_HHMM[1])}:00`, GLOBEX_TZ).getTime();
  // Only build the profile with data available up to when the trade was taken (entry).
  const closeMs = Math.min(sessionCloseMs, entry.getTime());
  const ib = londonIB(openMs, closeMs);
  // Previous Globex session, i.e. the last completed one before this session opened.
  // Unlike the current session it is not truncated at entry.
  const prevOpenDate = prevSessionOpenDate(openDate);
  const prevOpenMs = wallTimeToUtc(
    `${prevOpenDate} ${pad2(OPEN_HHMM[0])}:${pad2(OPEN_HHMM[1])}:00`, GLOBEX_TZ).getTime();
  const prevCloseMs = wallTimeToUtc(
    `${shiftDate(prevOpenDate, 1)} ${pad2(CLOSE_HHMM[0])}:${pad2(CLOSE_HHMM[1])}:00`, GLOBEX_TZ).getTime();
  const prevIb = londonIB(prevOpenMs, prevCloseMs);
  const { symbol, stype } = resolveSymbol(trade);
  return {
    trade, symbol, stype,
    openMs, closeMs, ibStartMs: ib && ib.ibStart, ibEndMs: ib && ib.ibEnd,
    prevOpenMs, prevCloseMs, prevIbStartMs: prevIb && prevIb.ibStart, prevIbEndMs: prevIb && prevIb.ibEnd,
  };
}

// GET: return profile only if the session window is already downloaded.
router.get('/:tradeId', async (req, res) => {
  try {
    const w = await tradeWindow(req.params.tradeId);
    if (!w) return res.status(404).json({ error: 'Trade not found' });
    if (w.err || !(await isCovered('candle_ranges', w.symbol, w.openMs, w.closeMs))) {
      return res.json({ cached: false });
    }
    const candles = await readRange('candle_ranges', w.symbol, w.openMs, w.closeMs);
    // The prior session may not be downloaded yet (it was added later than the cache) —
    // show today's profile regardless and only include yesterday when it's on disk.
    const prevCandles = (await isCovered('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs))
      ? await readRange('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs)
      : null;
    res.json(buildResponse(candles, w.symbol, 0, w, w.trade, prevCandles));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST: download the missing gaps of the session window, then return the profile.
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
    // Fetch each session on its own so the dead time between them is never requested:
    // the daily 16:00–17:00 CT break, and the whole weekend ahead of a Monday session.
    // Previous session first, so the current one is the newer entry if the cache evicts.
    const prevCov = await ensureCoverage('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs, fetchFn, CACHE_CAP);
    const curCov  = await ensureCoverage('candle_ranges', w.symbol, w.openMs, w.closeMs, fetchFn, CACHE_CAP);
    const cost = prevCov.cost + curCov.cost;
    const candles = await readRange('candle_ranges', w.symbol, w.openMs, w.closeMs);
    const prevCandles = await readRange('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs);
    res.json(buildResponse(candles, w.symbol, cost, w, w.trade, prevCandles));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Build the market profile for a trade from already-cached candles (no network fetch).
// Returns null when the session candles aren't downloaded yet or can't form a profile.
async function profileForTrade(tradeId) {
  const w = await tradeWindow(tradeId);
  if (!w || w.err || !w.symbol) return null;
  const candles = await readRange('candle_ranges', w.symbol, w.openMs, w.closeMs);
  if (!candles || !candles.length) return null;
  const profile = buildProfile(candles, w.openMs, w.closeMs, w.ibStartMs, w.ibEndMs);
  if (!profile) return null;
  // Only hand the model a prior session that is fully downloaded — a partially cached
  // one would give it a wrong prior high/low/POC to reason from.
  const prevCandles = (await isCovered('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs))
    ? await readRange('candle_ranges', w.symbol, w.prevOpenMs, w.prevCloseMs)
    : null;
  const prevProfile = (prevCandles && prevCandles.length)
    ? buildProfile(prevCandles, w.prevOpenMs, w.prevCloseMs, w.prevIbStartMs, w.prevIbEndMs, profile.row_size)
    : null;
  return {
    symbol: w.symbol, display_tz: LOCAL_TZ,
    session: { open: w.openMs, close: w.closeMs },
    prev_session: { open: w.prevOpenMs, close: w.prevCloseMs },
    profile,
    prev_profile: prevProfile,
    rth: rthState(candles, w.closeMs),
  };
}

// The NY cash-session open and its Initial Balance (09:30–10:30 ET), as of the entry.
// The profile's own IB is the London first hour, which suits the overnight auction but is
// not Dalton's IB; the AI reviewer needs the RTH one to judge range extension at the open.
function rthState(candles, entryMs) {
  const open = rthOpenMs(nySessionDate(entryMs));
  const ibEnd = open + 60 * 60000;
  if (entryMs <= open) return { status: 'pre-open', minutes_to_open: Math.round((open - entryMs) / 60000) };
  const cs = candles.filter(c => c.t >= open && c.t < Math.min(ibEnd, entryMs)).sort((a, b) => a.t - b.t);
  if (!cs.length) return { status: entryMs >= ibEnd ? 'complete' : 'forming', minutes_in: Math.round((entryMs - open) / 60000), missing: true };
  return {
    status: entryMs >= ibEnd ? 'complete' : 'forming',
    minutes_in: Math.min(60, Math.round((entryMs - open) / 60000)),
    open_price: cs[0].o,
    high: Math.max(...cs.map(c => c.h)),
    low: Math.min(...cs.map(c => c.l)),
  };
}

module.exports = router;
module.exports.buildProfile = buildProfile;       // exported for tests
module.exports.profileForTrade = profileForTrade;  // used by the AI analysis endpoint
