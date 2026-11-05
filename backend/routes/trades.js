const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { spawn } = require('child_process');
const { profileForTrade } = require('./tpo');
const { saveExecution } = require('../lib/executionStore');
const { executionBlock } = require('../lib/execution');
const { sameFamily } = require('../lib/symbols');
const { fmtEt, minutesFromRthOpen } = require('../lib/time');
const router = express.Router();

const LOCAL_TZ = process.env.TRADE_TZ || 'Australia/Sydney';

// When true, the analyze endpoint streams the built prompt to the UI instead of running
// Claude (prompt-inspection mode). false = real generation.
const SHOW_PROMPT_ONLY = false;

function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(tsStr.replace(' ', 'T') + 'Z');
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate  = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  return new Date(ref.getTime() + (utcDate.getTime() - tzDate.getTime()));
}

function toUtcMs(tsStr) {
  return tsStr ? wallTimeToUtc(tsStr, LOCAL_TZ).getTime() : null;
}

// Price with trailing zeros stripped: 7495.25000 -> "7495.25", 7494.00000 -> "7494".
function fmtPx(v) {
  return v == null ? v : (+Number(v).toFixed(5)).toString();
}
// Format a UTC ms instant as "YYYY-MM-DD HH:MM:SS" (matches the orderflow table's UTC frame).
function fmtUtc(ms) {
  return ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function utcHM(ms) {
  const t = new Date(ms);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
// Smallest positive price increment observed (the instrument's tick size).
function guessTick(ticks) {
  const ps = [...new Set(ticks.map(t => +Number(t.price).toFixed(5)))].sort((a, b) => a - b);
  let m = Infinity;
  for (let i = 1; i < ps.length && i < 800; i++) { const d = +(ps[i] - ps[i - 1]).toFixed(5); if (d > 0 && d < m) m = d; }
  return isFinite(m) ? m : 0.25;
}
// Diagonal-imbalance threshold (matches the footprint UI): a side is imbalanced when it is
// >= this many times the opposing volume one tick across the diagonal.
const IMBALANCE_RATIO = 2;
// An imbalance cell whose dominant side is under this share of its bar is flagged minor.
const MINOR_SHARE = 0.03;

// Per-tick bid × ask breakdown of one bar, windowed ±10 ticks around the reference price(s),
// with diagonal-imbalance and POC flags. `refs` = [{ price, tag }] to mark entry/exit rows.
function footprintBlock(bar, tick, refs, title) {
  if (!bar || !bar.levels) return '';
  const ks = Object.keys(bar.levels).map(Number);
  const refKs = refs.map(r => Math.round(r.price / tick));
  if (!ks.length || !refKs.length) return '';
  const loK = Math.max(Math.min(...ks), Math.min(...refKs) - 10);
  const hiK = Math.min(Math.max(...ks), Math.max(...refKs) + 10);
  let pocK = null, pocV = -1;
  for (const k of ks) { const [bd, ak] = bar.levels[k]; if (bd + ak > pocV) { pocV = bd + ak; pocK = k; } }

  // Share of the whole bar's volume, so a single cell can be weighed against the bar it sits
  // in. An imbalance whose dominant side is under MINOR_SHARE of the bar is marked minor —
  // technically 2:1, but too small to decide anything.
  const barVol = ks.reduce((sum, k) => sum + bar.levels[k][0] + bar.levels[k][1], 0) || 1;
  const lines = [];
  for (let k = hiK; k >= loK; k--) {
    const cell = bar.levels[k];
    if (!cell) continue;
    const [bid, ask] = cell;
    const bidBelow = (bar.levels[k - 1] || [0, 0])[0];
    const askAbove = (bar.levels[k + 1] || [0, 0])[1];
    const buyImb = ask > 0 && ask >= IMBALANCE_RATIO * Math.max(bidBelow, 1);
    const sellImb = bid > 0 && bid >= IMBALANCE_RATIO * Math.max(askAbove, 1);
    const minor = v => (v / barVol < MINOR_SHARE ? '·minor' : '');
    const flags = [
      buyImb ? '>ask' + minor(ask) : '',
      sellImb ? '<bid' + minor(bid) : '',
      k === pocK ? 'POC' : '',
      ...refs.filter(r => Math.round(r.price / tick) === k).map(r => r.tag),
    ].filter(Boolean).join(' ');
    const share = `${(((bid + ask) / barVol) * 100).toFixed(1)}%`;
    lines.push(`${fmtPx(k * tick).padStart(8)}  ${String(bid).padStart(6)} x ${String(ask).padEnd(6)} ${share.padStart(5)}${flags ? '  ' + flags : ''}`);
  }
  if (!lines.length) return '';
  return `\n\n=== FOOTPRINT DETAIL — ${title} (bid × ask per tick; % = that price's share of the bar's ${barVol} contracts; >ask = buy imbalance, <bid = sell imbalance; ·minor = dominant side under ${MINOR_SHARE * 100}% of the bar) ===\n${lines.join('\n')}`;
}

// META routes must come before /:id to avoid being swallowed by the param
router.get('/meta/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT account FROM trades ORDER BY account');
    res.json(rows.map(r => r.account));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/meta/instruments', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT instrument FROM trades ORDER BY instrument');
    res.json(rows.map(r => r.instrument));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades?from=&to=&account=&instrument=&direction=
router.get('/', async (req, res) => {
  try {
    const { from, to, account, instrument, direction } = req.query;
    const conditions = [];
    const values = [];

    if (from)      { conditions.push(`trade_date >= $${values.length + 1}`); values.push(from); }
    if (to)        { conditions.push(`trade_date <= $${values.length + 1}`); values.push(to); }
    if (account)   { conditions.push(`account = $${values.length + 1}`); values.push(account); }
    if (instrument){ conditions.push(`instrument = $${values.length + 1}`); values.push(instrument); }
    if (direction) { conditions.push(`direction = $${values.length + 1}`); values.push(direction); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT t.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color, 'group_name', tg.group_name))
          FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', ti.id, 'filename', ti.filename, 'original_name', ti.original_name))
          FILTER (WHERE ti.id IS NOT NULL), '[]') AS images
       FROM trades t
       LEFT JOIN trade_tags tt ON tt.trade_id = t.id
       LEFT JOIN tags tg ON tg.id = tt.tag_id
       LEFT JOIN trade_images ti ON ti.trade_id = t.id
       ${where}
       GROUP BY t.id
       ORDER BY t.entry_time DESC NULLS LAST`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows: [trade] } = await pool.query(
      `SELECT t.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color, 'group_name', tg.group_name))
          FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', ti.id, 'filename', ti.filename, 'original_name', ti.original_name))
          FILTER (WHERE ti.id IS NOT NULL), '[]') AS images
       FROM trades t
       LEFT JOIN trade_tags tt ON tt.trade_id = t.id
       LEFT JOIN tags tg ON tg.id = tt.tag_id
       LEFT JOIN trade_images ti ON ti.trade_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [req.params.id]
    );
    if (!trade) return res.status(404).json({ error: 'Not found' });

    const { rows: fills } = await pool.query(
      'SELECT * FROM fills WHERE trade_id = $1 ORDER BY fill_time',
      [req.params.id]
    );

    // check if tick data exists for this trade's time window
    let has_ticks = false;
    if (trade.entry_time) {
      const entryMs = toUtcMs(trade.entry_time);
      const exitMs  = toUtcMs(trade.exit_time) ?? entryMs + 900000;
      const { rows: [{ count }] } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM tick_ranges WHERE end_ms > $1 AND start_ms < $2`,
        [entryMs - 600000, exitMs + 300000]
      );
      has_ticks = count > 0;
    }

    res.json({ ...trade, fills, has_ticks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { description, ai_analysis } = req.body;
    const fields = [];
    const values = [];
    if (description !== undefined) { fields.push(`description = $${values.length + 1}`); values.push(description); }
    if (ai_analysis !== undefined) { fields.push(`ai_analysis = $${values.length + 1}`); values.push(ai_analysis); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.params.id);
    const { rows: [trade] } = await pool.query(
      `UPDATE trades SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!trade) return res.status(404).json({ error: 'Not found' });
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/analyze', async (req, res) => {
  const tradeId = req.params.id;
  console.log(`[analyze] START trade=${tradeId}`);
  try {
    const { rows: [trade] } = await pool.query(
      `SELECT t.*, COALESCE(json_agg(DISTINCT jsonb_build_object('name', tg.name, 'group_name', tg.group_name))
        FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags
       FROM trades t
       LEFT JOIN trade_tags tt ON tt.trade_id = t.id
       LEFT JOIN tags tg ON tg.id = tt.tag_id
       WHERE t.id = $1 GROUP BY t.id`,
      [req.params.id]
    );
    if (!trade) return res.status(404).json({ error: 'Not found' });
    console.log(`[analyze] trade fetched: ${trade.instrument} entry=${trade.entry_time}`);

    // --- build orderflow data from tick cache ---
    const instrument = trade.instrument;
    const contract = trade.contract || instrument;
    const MON_CODE = { 1:'F',2:'G',3:'H',4:'J',5:'K',6:'M',7:'N',8:'Q',9:'U',10:'V',11:'X',12:'Z' };
    const MON_NAME = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
    const QUARTERLY = [[3,'H'],[6,'M'],[9,'U'],[12,'Z']];
    const contractParts = contract.trim().split(/\s+/);
    let symbol = null;
    if (contractParts.length >= 2) {
      const base = contractParts[0].toUpperCase();
      const rest = contractParts.slice(1).join('');
      let mon, yy, cm;
      if ((cm = rest.match(/^([A-Za-z]{3})(\d{2})$/))) { mon = MON_NAME[cm[1].toUpperCase()]; yy = cm[2]; }
      else if ((cm = rest.match(/^(\d{1,2})-(\d{2})$/))) { mon = parseInt(cm[1], 10); yy = cm[2]; }
      if (mon && yy) symbol = `${base}${MON_CODE[mon]}${yy[1]}`;
    }
    if (!symbol) {
      const base = String(instrument).trim().split(/\s+/)[0].toUpperCase();
      const m = (trade.entry_time || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const [, yr, mo, day] = m.map(Number);
        for (const [qMo, code] of QUARTERLY) {
          if (qMo > mo || (qMo === mo && day < 15)) { symbol = `${base}${code}${String(yr).slice(-1)}`; break; }
        }
        if (!symbol) symbol = `${base}H${String(Number(m[1]) + 1).slice(-1)}`;
      }
    }
    if (!symbol) symbol = `${instrument}.c.0`;
    console.log(`[analyze] resolved symbol=${symbol}`);

    let tickSection = '';
    let execSection = '';
    if (trade.entry_time) {
      const entryMs = toUtcMs(trade.entry_time);
      const exitMs  = toUtcMs(trade.exit_time) ?? entryMs + 900000;
      const startMs = entryMs - 20 * 60000;
      const endMs = exitMs + 15 * 60000;
      console.log(`[analyze] querying tick_ranges symbol=${symbol} window=[${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()}]`);

      const { rows: rangeRows } = await pool.query(
        `SELECT records FROM tick_ranges WHERE symbol = $1 AND end_ms > $2 AND start_ms < $3 ORDER BY start_ms`,
        [symbol, startMs, endMs]
      );
      console.log(`[analyze] tick_ranges rows=${rangeRows.length}`);
      const allTicks = [];
      for (const r of rangeRows)
        for (const tick of r.records)
          if (tick.t >= startMs && tick.t < endMs) allTicks.push(tick);
      allTicks.sort((a, b) => a.t - b.t);

      if (allTicks.length > 0) {
        // Aggregate into 1-minute bars, tracking per-price bid/ask for footprint + imbalances.
        const BAR_MS = 60000;
        const tick = guessTick(allTicks);
        const bars = {};
        let cumDelta = 0;
        for (const tk of allTicks) {
          const barTs = Math.floor(tk.t / BAR_MS) * BAR_MS;
          if (!bars[barTs]) bars[barTs] = { ts: barTs, buyVol: 0, sellVol: 0, high: tk.price, low: tk.price, prices: {}, levels: {} };
          const b = bars[barTs];
          if (tk.side === 'B') b.buyVol += tk.size; else b.sellVol += tk.size;
          if (tk.price > b.high) b.high = tk.price;
          if (tk.price < b.low) b.low = tk.price;
          b.prices[tk.price] = (b.prices[tk.price] || 0) + tk.size;
          // bid = sell aggressor ('A'), ask = buy aggressor ('B'), keyed by tick index
          const k = Math.round(tk.price / tick);
          if (!b.levels[k]) b.levels[k] = [0, 0];
          if (tk.side === 'A') b.levels[k][0] += tk.size;
          else if (tk.side === 'B') b.levels[k][1] += tk.size;
        }

        const sortedBars = Object.values(bars).sort((a, b) => a.ts - b.ts);
        const lines = ['Time  | Buy Vol | Sell Vol | Delta | Cum Δ  | Range          | POC     | Note'];
        lines.push('------|---------|----------|-------|--------|----------------|---------|-----');
        for (const b of sortedBars) {
          const delta = b.buyVol - b.sellVol;
          cumDelta += delta;
          const poc = Object.entries(b.prices).sort((a, b) => b[1] - a[1])[0][0];
          const isEntry = b.ts <= entryMs && entryMs < b.ts + BAR_MS;
          const isExit  = trade.exit_time && b.ts <= exitMs && exitMs < b.ts + BAR_MS;
          const note = [isEntry ? '← ENTRY' : '', isExit ? '← EXIT' : ''].filter(Boolean).join(' ');
          lines.push(
            `${utcHM(b.ts)} | ${String(b.buyVol).padStart(7)} | ${String(b.sellVol).padStart(8)} | ${String(delta).padStart(5)} | ${String(cumDelta).padStart(6)} | ${fmtPx(b.high)}-${fmtPx(b.low)} | ${fmtPx(poc)} | ${note}`
          );
        }

        // Stacked diagonal imbalances (3+ consecutive same-direction levels within a bar).
        const imbLines = [];
        for (const b of sortedBars) {
          const ks = Object.keys(b.levels).map(Number);
          if (!ks.length) continue;
          const minK = Math.min(...ks), maxK = Math.max(...ks);
          const flag = {};
          for (const k of ks) {
            const [bid, ask] = b.levels[k];
            const bidBelow = (b.levels[k - 1] || [0, 0])[0];
            const askAbove = (b.levels[k + 1] || [0, 0])[1];
            if (ask > 0 && ask >= IMBALANCE_RATIO * Math.max(bidBelow, 1)) flag[k] = 'B';
            else if (bid > 0 && bid >= IMBALANCE_RATIO * Math.max(askAbove, 1)) flag[k] = 'S';
          }
          let dir = null, sK = null, eK = null;
          for (let k = minK; k <= maxK + 1; k++) {
            const d = k <= maxK ? (flag[k] || null) : null;
            if (d && d === dir) { eK = k; continue; }
            if (dir && eK - sK + 1 >= 3) imbLines.push(`${utcHM(b.ts)}  ${dir === 'B' ? 'BUY ' : 'SELL'}  ${fmtPx(sK * tick)}–${fmtPx(eK * tick)} (${eK - sK + 1})`);
            if (d) { dir = d; sK = k; eK = k; } else dir = null;
          }
        }
        const imbSection = imbLines.length
          ? `\n\n=== STACKED DIAGONAL IMBALANCES (BUY = ask ≥${IMBALANCE_RATIO}× bid one tick below; SELL = bid ≥${IMBALANCE_RATIO}× ask one tick above; 3+ stacked levels) ===\n${imbLines.slice(0, 40).join('\n')}`
          : '';

        // Detailed footprint of the entry and exit bars. On a scalp both fills usually land in
        // the same 1-min bar, so merge into one block with both markers rather than repeat it.
        let fpSection = '';
        const ePx = Number(trade.entry_price);
        const xPx = trade.exit_price != null ? Number(trade.exit_price) : NaN;
        const entryBarTs = Math.floor(entryMs / BAR_MS) * BAR_MS;
        const exitBarTs = trade.exit_time ? Math.floor(exitMs / BAR_MS) * BAR_MS : null;

        if (exitBarTs === entryBarTs && Number.isFinite(ePx) && Number.isFinite(xPx)) {
          fpSection = footprintBlock(bars[entryBarTs], tick,
            [{ price: ePx, tag: '←ENTRY' }, { price: xPx, tag: '←EXIT' }],
            `entry + exit bar ${utcHM(entryBarTs)} UTC`);
        } else {
          if (Number.isFinite(ePx)) {
            fpSection += footprintBlock(bars[entryBarTs], tick,
              [{ price: ePx, tag: '←ENTRY' }], `entry bar ${utcHM(entryBarTs)} UTC`);
          }
          if (exitBarTs != null && Number.isFinite(xPx)) {
            fpSection += footprintBlock(bars[exitBarTs], tick,
              [{ price: xPx, tag: '←EXIT' }], `exit bar ${utcHM(exitBarTs)} UTC`);
          }
        }

        const cumNote = `Cum Δ accumulates from the first bar shown (${utcHM(sortedBars[0].ts)} UTC, 20 min before entry). It is NOT session cumulative delta.`;
        tickSection = `\n\n=== ORDERFLOW DATA (1-min bars, UTC) ===\nTotal ticks: ${allTicks.length}\n${cumNote}\n\n${lines.join('\n')}${imbSection}${fpSection}`;
        // Measured outcome (and persisted, since these ticks will eventually be evicted).
        try { execSection = executionBlock(await saveExecution(trade, allTicks)); }
        catch (e) { console.error('[analyze] execution metrics failed:', e.message); }
        console.log(`[analyze] built tick section: ${allTicks.length} ticks, ${sortedBars.length} bars, ${imbLines.length} imbalance runs`);
      }
    }
    console.log(`[analyze] tickSection populated=${!!tickSection}`);

    // --- TPO / market profile context (compact summary, cached candles only) ---
    const entryPx = trade.entry_price != null ? Number(trade.entry_price) : null;
    const exitPx  = trade.exit_price  != null ? Number(trade.exit_price)  : null;
    let tpoSection = '';
    try {
      const tpo = await profileForTrade(tradeId);
      if (tpo && tpo.profile) {
        const p = tpo.profile;
        const f = v => Number(v).toFixed(p.decimals);
        const where = px => px == null ? 'n/a' : [
          px > p.va.high ? 'above VA' : px < p.va.low ? 'below VA' : 'inside VA',
          px > p.poc ? 'above POC' : px < p.poc ? 'below POC' : 'at POC',
          p.ib ? (px > p.ib.high ? 'above London IB' : px < p.ib.low ? 'below London IB' : 'inside London IB') : null,
        ].filter(Boolean).join(', ');

        // Full letter matrix (high -> low). Length of each row = TPO count; the letters are
        // the 30-min brackets that traded there (time sequence = value migration = trend).
        const half = (p.row_size || 0) / 2;
        const near = (a, b) => b != null && Math.abs(a - b) < half;
        const openUtc = new Date(tpo.session.open).toISOString().slice(11, 16);
        const matrix = p.rows.filter(r => r.count > 0).map(r => {
          const tags = [];
          if (near(r.price, p.poc)) tags.push('POC');
          if (near(r.price, p.va.high)) tags.push('VAH');
          if (near(r.price, p.va.low)) tags.push('VAL');
          if (p.ib && near(r.price, p.ib.high)) tags.push('IBH');
          if (p.ib && near(r.price, p.ib.low)) tags.push('IBL');
          return `${f(r.price).padStart(8)}  ${r.letters}${tags.length ? '  <' + tags.join(',') : ''}`;
        }).join('\n');

        // Prior (completed) Globex session — the reference the current auction opens against.
        const pp = tpo.prev_profile;
        let prevBlock = '';
        if (pp) {
          const pf = v => Number(v).toFixed(pp.decimals);
          const pHalf = (pp.row_size || 0) / 2;
          const pNear = (a, b) => b != null && Math.abs(a - b) < pHalf;
          const prevOpenUtc = new Date(tpo.prev_session.open).toISOString().slice(11, 16);
          const prevMatrix = pp.rows.filter(r => r.count > 0).map(r => {
            const tags = [];
            if (pNear(r.price, pp.poc)) tags.push('pPOC');
            if (pNear(r.price, pp.va.high)) tags.push('pVAH');
            if (pNear(r.price, pp.va.low)) tags.push('pVAL');
            return `${pf(r.price).padStart(8)}  ${r.letters}${tags.length ? '  <' + tags.join(',') : ''}`;
          }).join('\n');
          const vsPrev = px => px == null ? 'n/a'
            : px > pp.va.high ? 'above prior VA' : px < pp.va.low ? 'below prior VA' : 'inside prior VA';
          prevBlock = `\n\n=== PREVIOUS SESSION PROFILE (completed Globex session, A=${prevOpenUtc} UTC then +30m each) ===
${prevMatrix}

Prior POC ${pf(pp.poc)} | Prior value area ${pf(pp.va.high)}–${pf(pp.va.low)} | Prior range ${pf(pp.session_high)}–${pf(pp.session_low)} | Prior TPO ${pp.tpo_over} above POC / ${pp.tpo_under} below
Today's value vs prior: POC ${f(p.poc)} vs ${pf(pp.poc)} (${p.poc > pp.poc ? 'higher' : p.poc < pp.poc ? 'lower' : 'unchanged'}), VA ${f(p.va.high)}–${f(p.va.low)} vs ${pf(pp.va.high)}–${pf(pp.va.low)} → value ${p.va.low > pp.va.high ? 'higher (accepted above prior VA)' : p.va.high < pp.va.low ? 'lower (accepted below prior VA)' : p.va.high > pp.va.high && p.va.low > pp.va.low ? 'overlapping-to-higher' : p.va.high < pp.va.high && p.va.low < pp.va.low ? 'overlapping-to-lower' : 'overlapping / unchanged'}
Entry ${entryPx != null ? f(entryPx) : 'n/a'} → ${vsPrev(entryPx)}; Exit ${exitPx != null ? f(exitPx) : 'n/a'} → ${vsPrev(exitPx)}`;
        }

        // The NY cash session and its Initial Balance — Dalton's IB. The profile's own IB is
        // the London first hour, an overnight reference only.
        const r = tpo.rth;
        const vsRange = (px, hi, lo) => px > hi ? 'above it' : px < lo ? 'below it' : `inside it (${hi - lo > 0 ? Math.round(((px - lo) / (hi - lo)) * 100) : 50}% of the way up)`;
        const rthLine = !r ? ''
          : r.status === 'pre-open' ? `RTH (NY cash session): not open yet — entry is ${r.minutes_to_open} min before the 09:30 ET open. Pre-market tape is thin; little structure forms here. There is no RTH Initial Balance yet.`
          : r.missing ? `RTH (NY cash session): ${r.minutes_in} min in; opening candles not cached, so the RTH range is unknown.`
          : r.status === 'forming' ? `RTH (NY cash session): opened 09:30 ET at ${fmtPx(r.open_price)}. Initial Balance (09:30–10:30 ET) is still FORMING — ${r.minutes_in} of 60 min in, range so far ${fmtPx(r.high)}–${fmtPx(r.low)}. Entry ${entryPx != null ? fmtPx(entryPx) : 'n/a'} is ${entryPx != null ? vsRange(entryPx, r.high, r.low) : 'n/a'}. Range extension and day type cannot be confirmed until the IB completes.`
          : `RTH (NY cash session): opened 09:30 ET at ${fmtPx(r.open_price)}. Initial Balance complete ${fmtPx(r.high)}–${fmtPx(r.low)}. Entry ${entryPx != null ? fmtPx(entryPx) : 'n/a'} is ${entryPx != null ? vsRange(entryPx, r.high, r.low) : 'n/a'}.`;

        tpoSection = `\n\n=== MARKET PROFILE / TPO (full Globex session up to entry; 30-min brackets, A=${openUtc} UTC then +30m each) ===
Letter profile (price high→low; letters = brackets that traded there, so row length = TPO count and letter order = time):
${matrix}

POC ${f(p.poc)} | Value area ${f(p.va.high)}–${f(p.va.low)} | London IB ${p.ib ? `${f(p.ib.high)}–${f(p.ib.low)}` : 'not yet formed'} (overnight reference only — NOT Dalton's Initial Balance) | Session ${f(p.session_high)}–${f(p.session_low)} | TPO ${p.tpo_over} above POC / ${p.tpo_under} below
Entry ${entryPx != null ? f(entryPx) : 'n/a'} → ${where(entryPx)}; Exit ${exitPx != null ? f(exitPx) : 'n/a'} → ${where(exitPx)}
${rthLine}${prevBlock}`;
      }
    } catch (e) { console.error('[analyze] tpo section error:', e.message); }
    console.log(`[analyze] tpoSection populated=${!!tpoSection}`);

    // --- imported levels for this session (same instrument, nearest day within ±1) ---
    let levelsSection = '';
    try {
      // The levels for this trade's NY session, same contract family (ES levels apply to an
      // MES trade — same prices). Exact session match: a Sydney date can hold two sessions.
      const { rows: lvRows } = await pool.query(
        'SELECT levels, instrument, session_date FROM day_levels WHERE session_date = $1',
        [trade.session_date]);
      const [lv] = lvRows.filter(r => sameFamily(r.instrument, trade.instrument));
      // Drop objects nowhere near the market — exports have carried phantom drawings at
      // prices like 1.25 on an ES chart, and they are pure noise to the reviewer.
      const near = px => entryPx == null || Math.abs(px - entryPx) <= entryPx * 0.1;
      const all = (lv && lv.levels) || [];
      const objs = all.filter(o => o.kind === 'zone' ? near(o.high) && near(o.low)
        : o.kind === 'trend' ? near(o.p1) && near(o.p2) : near(o.price));
      const dropped = all.length - objs.length;
      if (objs.length) {
        const lines = objs.filter(o => o.kind === 'line' || o.kind === 'ray').map(o => o.price).sort((a, b) => a - b);
        const zones = objs.filter(o => o.kind === 'zone').map(o => `${o.high}–${o.low}`);
        const trends = objs.filter(o => o.kind === 'trend').map(o => `${o.p1}→${o.p2}${o.label ? ` (${o.label})` : ''}`);
        let nearTxt = '';
        if (entryPx != null && lines.length) {
          const above = lines.filter(p => p >= entryPx)[0];
          const below = [...lines].reverse().filter(p => p <= entryPx)[0];
          nearTxt = `\nNearest to entry ${entryPx}: above ${above ?? 'none'}, below ${below ?? 'none'}`;
        }
        levelsSection = `\n\n=== TRADER'S MARKED LEVELS (imported for the session) ===
Horizontal S/R (${lines.length}): ${lines.join(', ') || 'none'}
Zones (${zones.length}): ${zones.join(', ') || 'none'}${trends.length ? `\nTrendlines (${trends.length}): ${trends.join(' | ')}` : ''}${nearTxt}${dropped ? `\n(${dropped} imported objects far from the market were omitted as export junk.)` : ''}`;
      }
    } catch (e) { console.error('[analyze] levels section error:', e.message); }
    console.log(`[analyze] levelsSection populated=${!!levelsSection}`);

    // --- build prompt ---
    const tags = (trade.tags || []).map(t => t.group_name ? `${t.group_name}/${t.name}` : t.name).join(', ');
    const pnl = trade.net_pnl != null ? `$${parseFloat(trade.net_pnl).toFixed(2)}` : 'open';
    const entryUtcMs = toUtcMs(trade.entry_time);
    const exitUtcMs  = toUtcMs(trade.exit_time);
    const durMs = (entryUtcMs != null && exitUtcMs != null) ? exitUtcMs - entryUtcMs : null;
    const duration = durMs == null ? 'unknown'
      : durMs < 60000 ? `${Math.round(durMs / 1000)} seconds`
      : `${Math.round(durMs / 60000)} minutes`;

    const rthMin = entryUtcMs != null ? minutesFromRthOpen(entryUtcMs) : null;
    const whenEt = entryUtcMs == null ? ''
      : ` = ${fmtEt(entryUtcMs)}, ${rthMin >= 0 ? `${rthMin} min after` : `${-rthMin} min before`} the 09:30 ET cash open${rthMin < 0 && rthMin > -24 * 60 ? ' (pre-market)' : ''}`;

    const prompt = `You are a senior orderflow mentor reviewing one trade from a futures scalper's journal, using James Dalton's Auction Market Theory (Mind Over Markets / Markets in Profile) as the lens. Give an honest, useful review: what the trader did well, what actually cost them, and the one change that matters most. Accurate, not harsh — the aim is a review a good coach would give, not a list of every imperfection.

## How to weigh evidence (read before anything else)
- **The OBJECTIVE OUTCOME block is measured tick-by-tick and is ground truth.** Your grades must be consistent with it. If your read of the tape conflicts with it, the measurement wins unless you can name a specific, material reason.
- **Materiality.** A single footprint cell is not a signal unless it is a large share of its bar (the % column) or part of a stacked run. Cells marked ·minor never decide anything. A move smaller than one normal 1-minute range (given in the objective block) is noise — do not build a verdict on it.
- **Thin tape** (pre-market, low bar volume) forms little structure. Say so plainly rather than reading an auction into it.
- **Timeframe.** This is a scalper. Direction is judged on the next several minutes, as measured — not on where the day went later.
- **Cum Δ** in the table starts at the first bar shown (20 min before entry). It is window delta, not session delta — weigh it as "the last 20 minutes".
- Cite the specific numbers that carry your point, once each. Do not pad with numbers that don't change the conclusion.

## Framework — Dalton AMT
- Start with Dalton's two questions: **which way is the market trying to go, and is it doing a good job of it?**
- Value = the 70% value area where trade was accepted; POC = the fairest price.
- **Balance** (rotational, two-sided): responsive trades at references — VA edges, POC, range extremes, the trader's marked levels — are valid, high-quality plays. The target is rotation toward POC / the opposite edge.
- **Imbalance / one-timeframe** (range extension, value migrating, sustained initiative flow): trade with the other-timeframe participant. Fading a *confirmed* one-timeframe move is the classic error.
- **Confirming one-timeframe takes real structure.** A strong 10-minute push is not by itself a trend day. The RTH Initial Balance is the first hour of the NY cash session (09:30–10:30 ET): while it is still forming, do not call range extension or day type with confidence — say what is developing instead.
- **The profile's "London IB" is an overnight reference only.** Use it as a price level if it matters; never apply Initial Balance / range-extension logic to it.
- **Initiative** = buying above value or selling below value. **Responsive** = buying below value or selling above value.
- **Excess** (a tail) = the auction finished properly. **Poor high/low** = unfinished business, likely revisited. **Single prints** act as later support/resistance.
- **Location is the edge.** Genuine references include POC, VA edges, the forming RTH range extremes, prior-session references, excess, single prints and the trader's own marked levels. "Mid-value" means genuinely away from all of them — not merely inside the value area.

## This trader — a scalper (day timeframe; holds of seconds to minutes)
- A short hold is not itself a fault.
- **Stop and target size relative to normal noise is part of the trade — but judge it by the measured direction.** When the direction was measured CORRECT and a stop inside one normal minute's range was tagged before the move, the stop (not the idea) lost the trade — say so, and use the fixed stop/target comparison to show it. When the direction was INCORRECT or PARTIAL, a tight stop that kept the loss small was good risk control, not a fault.
- Trader's own terms (use exactly): "sell absorption" = buyers absorbing sellers, price holds/reverses up despite sell flow. "buy absorption" = sellers absorbing buyers, price holds/reverses down despite buy flow. "absorption" unqualified = the passive side blocking continuation at a level. Tags follow group/name.

## Grading rubric (apply literally)
- **ENTRY** — *good*: at a genuine reference with material orderflow support, and the heat before the move stayed within about one normal minute's range. *ok*: a reasonable idea with one real weakness (early or late, a weak reference, or heat beyond noise). *poor*: no reference and no material support, or entered straight into confirmed one-timeframe flow. An entry cannot be *poor* when the measured 5-minute excursion is at least 2× in its favour unless you name a material reason it was luck; it cannot be *good* when the measured direction verdict is INCORRECT.
- **EXIT** — *good*: at or near a logical auction target; or, on a trade whose measured direction was incorrect or partial, a stop that kept the loss small. *ok*: sensible, but left most of the available move or cut on something minor. *poor*: a stop inside normal noise tagged before a measured-CORRECT move (the stop, not the idea, lost the trade), or an exit with no logic.
- **DIRECTION** — use the measured direction verdict exactly (correct / partial / incorrect). Explain why the tape did what it did; do not override the verdict.
- **SCORE /10** — weigh location, direction and management roughly equally. 9–10 exceptional; 7–8 good with minor flaws; 5–6 adequate with a real issue; 3–4 weak on two of the three; 0–2 wrong on every measure. A trade whose measured direction is correct and whose entry worked should not score below 5 because of a secondary flaw.

## Trade
${trade.instrument} | ${trade.direction} | Qty ${trade.quantity}
Entry ${fmtPx(trade.entry_price)} @ ${fmtUtc(entryUtcMs) || '?'} UTC | Exit ${trade.exit_price != null ? fmtPx(trade.exit_price) : 'open'} @ ${fmtUtc(exitUtcMs) || 'N/A'} UTC
Net P&L ${pnl} | Duration ${duration} | Tags ${tags || 'none'}
Timing: entry ${fmtUtc(entryUtcMs) ? fmtUtc(entryUtcMs).slice(11, 16) : '?'} UTC${whenEt}
Notes: ${trade.description || 'none'}
${execSection}${tickSection}${tpoSection}${levelsSection}

## Deliver (concise, evidence-first)
Use exactly these numbered sections. State each piece of evidence once; later sections may refer back but must not restate it. If a section has nothing material to add, keep it to one line. No closing recap in prose.

1. **Auction context** — Dalton's two questions, briefly: balance or developing imbalance, where value sits against the prior session, and where the RTH session stood at entry (pre-market / IB forming / IB complete). Say what is not yet knowable.
2. **Location & entry** — the reference the entry sat on (or honestly, that there wasn't one), the material orderflow at the entry, and the measured heat before the move.
3. **Direction** — the measured verdict, and what in the tape explains it. Responsive or initiative, and whether that suited the auction state.
4. **Risk & management** — stop size against normal noise, exit against the available move (capture), and what the fixed stop/target comparison shows. This is often where the result was decided — give it proper weight.
5. **What went right** — one or two lines on what the trader did well. If genuinely nothing, say so in one line.
6. **Key lesson** — the single highest-impact change, concrete and checkable next time. Not a recap.
7. **Score /10** — one line of justification against the rubric.

End with exactly this block, nothing after. One sentence per note, introducing nothing not already established above:

---
ENTRY: <good|ok|poor> | <one sentence>
EXIT: <good|ok|poor> | <one sentence>
DIRECTION: <correct|partial|incorrect> | <one sentence>
SCORE: <number>/10`;

    // For testing: dump the exact prompt + size so we can gauge context usage.
    console.log(`[analyze] PROMPT ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens) — sections: tick=${!!tickSection} tpo=${!!tpoSection} levels=${!!levelsSection}`);
    try {
      const dumpPath = path.join(__dirname, '..', 'last-prompt.txt');
      fs.writeFileSync(dumpPath, prompt);
      console.log(`[analyze] prompt written to ${dumpPath}`);
    } catch (e) { console.error('[analyze] prompt dump failed:', e.message); }
    console.log('[analyze] ----- PROMPT BEGIN -----\n' + prompt + '\n[analyze] ----- PROMPT END -----');

    if (!tickSection) {
      console.log(`[analyze] ABORT: no tick data for symbol=${symbol}`);
      return res.status(400).json({ error: 'No tick data available for this trade. Grab footprint data first.' });
    }

    // Stream SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': ping\n\n');

    // TEMP: stream the prompt to the UI instead of generating.
    if (SHOW_PROMPT_ONLY) {
      console.log('[analyze] SHOW_PROMPT_ONLY — returning prompt, not generating');
      const header = `**🔧 Prompt preview — generation disabled.** ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens).\n\n`;
      res.write(`data: ${JSON.stringify({ text: header })}\n\n`);
      res.write(`data: ${JSON.stringify({ text: '```text\n' + prompt + '\n```' })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    }

    console.log(`[analyze] SSE headers flushed, spawning claude`);

    let fullText = '';
    let thinkingChars = 0;
    const t0 = Date.now();
    const THINKING_STAGE = 'Model is reasoning…';
    res.write(`data: ${JSON.stringify({ stage: THINKING_STAGE, elapsed: 0 })}\n\n`);

    // Progress ticks double as the keep-alive. The reasoning phase produces no answer text,
    // so surface the thinking volume instead — otherwise the UI looks frozen for minutes.
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (fullText) return res.write(`data: ${JSON.stringify({ elapsed })}\n\n`);
      const approxTokens = Math.round(thinkingChars / 4);
      const stage = approxTokens
        ? `Model is reasoning… ~${approxTokens.toLocaleString()} thinking tokens`
        : THINKING_STAGE;
      res.write(`data: ${JSON.stringify({ elapsed, stage })}\n\n`);
    }, 5000);

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    console.log(`[analyze] claudePath=${claudePath}`);
    // stream-json + partial messages gives real incremental output. In the default text mode
    // the CLI buffers the whole answer and prints it at the end, so the UI sat on one status
    // for minutes and every progress stage fired at once.
    // Thinking budget. Without --effort the CLI picks its own default and emits no
    // thinking deltas at all, so the progress readout never leaves the generic stage.
    // Set ANALYZE_EFFORT to low|medium|high|xhigh|max to trade latency for depth.
    const effort = process.env.ANALYZE_EFFORT || 'medium';
    const model = process.env.ANALYZE_MODEL || 'claude-sonnet-5';
    // effort=none reproduces the original invocation, which passed no --effort at all.
    const effortArgs = effort === 'none' ? [] : ['--effort', effort];
    // Do NOT strip the CLI's default system prompt to save input tokens: measured, it
    // backfires. The ~16k harness prefix is byte-identical across calls and comes back as
    // cheap cache_read; replacing it makes every call a full-price cache_creation instead
    // (cached=0), and it stops suppressing extended thinking, adding ~6k output tokens.
    // Net effect measured on trade 309: $0.21/analysis vs ~$0.06 with the defaults.
    const child = spawn(claudePath, [
      '-p', '--no-session-persistence', '--model', model,
      ...effortArgs,
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[analyze] config model=${model} effort=${effort}`);
    console.log(`[analyze] claude spawned pid=${child.pid}`);

    child.on('error', err => {
      console.error(`[analyze] spawn error:`, err.message);
      res.write(`data: ${JSON.stringify({ error: `Failed to start claude: ${err.message}` })}\n\n`);
      res.end();
    });

    // Parse the CLI's NDJSON stream: thinking deltas drive the progress readout, text deltas
    // are forwarded to the browser as they arrive.
    let ndjson = '';
    let writing = false;
    child.stdout.on('data', chunk => {
      ndjson += chunk.toString();
      const lines = ndjson.split('\n');
      ndjson = lines.pop();                       // keep the trailing partial line
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'result' && ev.usage) {
          const u = ev.usage;
          const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          console.log(`[analyze] USAGE in=${inTok} (new=${u.cache_creation_input_tokens || 0} cached=${u.cache_read_input_tokens || 0}) out=${u.output_tokens || 0} think=${(u.output_tokens_details || {}).thinking_tokens || 0} cost=$${(ev.total_cost_usd || 0).toFixed(4)} api=${ev.duration_api_ms}ms`);
        }
        if (ev.type === 'result' && !fullText && typeof ev.result === 'string') {
          fullText = ev.result;                   // fallback if no deltas were seen
          res.write(`data: ${JSON.stringify({ text: fullText })}\n\n`);
          continue;
        }
        if (ev.type !== 'stream_event' || !ev.event) continue;
        const e = ev.event;

        if (e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'thinking_delta') {
            thinkingChars += (e.delta.thinking || '').length;
          } else if (e.delta.type === 'text_delta') {
            const text = e.delta.text || '';
            if (!writing) {
              writing = true;
              console.log(`[analyze] first text after ${Math.round((Date.now() - t0) / 1000)}s (thinking ~${thinkingChars} chars)`);
              res.write(`data: ${JSON.stringify({ stage: 'Writing analysis…' })}\n\n`);
            }
            fullText += text;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }
      }
    });

    child.stderr.on('data', data => console.error('[analyze] claude stderr:', data.toString()));

    child.on('close', async code => {
      clearInterval(heartbeat);
      console.log(`[analyze] claude closed code=${code} textLen=${fullText.length}`);
      if (code === 0 && fullText.trim()) {
        const parse = (field, pattern) => {
          const m = fullText.match(pattern);
          return m ? m[1].trim() : null;
        };
        const scoreMatch  = fullText.match(/^SCORE:\s*(\d+(?:\.\d+)?)\/10/im);
        const entryMatch  = fullText.match(/^ENTRY:\s*(good|ok|poor)\s*\|\s*(.+)/im);
        const exitMatch   = fullText.match(/^EXIT:\s*(good|ok|poor)\s*\|\s*(.+)/im);
        const dirMatch    = fullText.match(/^DIRECTION:\s*(correct|partial|incorrect)\s*\|\s*(.+)/im);

        const score           = scoreMatch  ? parseFloat(scoreMatch[1])  : null;
        const entryGrade      = entryMatch  ? entryMatch[1].toLowerCase() : null;
        const entryNote       = entryMatch  ? entryMatch[2].trim()        : null;
        const exitGrade       = exitMatch   ? exitMatch[1].toLowerCase()  : null;
        const exitNote        = exitMatch   ? exitMatch[2].trim()         : null;
        const directionGrade  = dirMatch    ? dirMatch[1].toLowerCase()   : null;
        const directionNote   = dirMatch    ? dirMatch[2].trim()          : null;

        await pool.query(
          `UPDATE trades SET
            ai_analysis = $1, ai_score = $2,
            ai_entry_grade = $3, ai_entry_note = $4,
            ai_exit_grade = $5, ai_exit_note = $6,
            ai_direction_correct = $7, ai_direction_note = $8
           WHERE id = $9`,
          [fullText.trim(), score, entryGrade, entryNote, exitGrade, exitNote, directionGrade, directionNote, req.params.id]
        );
        res.write(`data: ${JSON.stringify({ done: true, score, entryGrade, entryNote, exitGrade, exitNote, directionGrade, directionNote })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`);
      }
      res.end();
    });

    req.on('close', () => { clearInterval(heartbeat); child.kill(); });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM trades WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/tags/:tagId', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO trade_tags (trade_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.params.tagId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM trade_tags WHERE trade_id = $1 AND tag_id = $2',
      [req.params.id, req.params.tagId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
