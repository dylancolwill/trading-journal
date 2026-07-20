const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { spawn } = require('child_process');
const { profileForTrade } = require('./tpo');
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

  const lines = [];
  for (let k = hiK; k >= loK; k--) {
    const cell = bar.levels[k];
    if (!cell) continue;
    const [bid, ask] = cell;
    const bidBelow = (bar.levels[k - 1] || [0, 0])[0];
    const askAbove = (bar.levels[k + 1] || [0, 0])[1];
    const flags = [
      ask > 0 && ask >= IMBALANCE_RATIO * Math.max(bidBelow, 1) ? '>ask' : '',
      bid > 0 && bid >= IMBALANCE_RATIO * Math.max(askAbove, 1) ? '<bid' : '',
      k === pocK ? 'POC' : '',
      ...refs.filter(r => Math.round(r.price / tick) === k).map(r => r.tag),
    ].filter(Boolean).join(' ');
    lines.push(`${fmtPx(k * tick).padStart(8)}  ${String(bid).padStart(6)} x ${String(ask).padEnd(6)}${flags ? '  ' + flags : ''}`);
  }
  if (!lines.length) return '';
  return `\n\n=== FOOTPRINT DETAIL — ${title} (bid × ask per tick; >ask = buy imbalance, <bid = sell imbalance) ===\n${lines.join('\n')}`;
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

        tickSection = `\n\n=== ORDERFLOW DATA (1-min bars, UTC) ===\nTotal ticks: ${allTicks.length}\n\n${lines.join('\n')}${imbSection}${fpSection}`;
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
          p.ib ? (px > p.ib.high ? 'above IB' : px < p.ib.low ? 'below IB' : 'inside IB') : null,
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

        tpoSection = `\n\n=== MARKET PROFILE / TPO (Globex session up to entry; 30-min brackets, A=${openUtc} UTC then +30m each) ===
Letter profile (price high→low; letters = brackets that traded there, so row length = TPO count and letter order = time):
${matrix}

POC ${f(p.poc)} | Value area ${f(p.va.high)}–${f(p.va.low)} | London IB ${p.ib ? `${f(p.ib.high)}–${f(p.ib.low)}` : 'not yet formed'} | Session ${f(p.session_high)}–${f(p.session_low)} | TPO ${p.tpo_over} above POC / ${p.tpo_under} below
Entry ${entryPx != null ? f(entryPx) : 'n/a'} → ${where(entryPx)}; Exit ${exitPx != null ? f(exitPx) : 'n/a'} → ${where(exitPx)}`;
      }
    } catch (e) { console.error('[analyze] tpo section error:', e.message); }
    console.log(`[analyze] tpoSection populated=${!!tpoSection}`);

    // --- imported levels for this session (same instrument, nearest day within ±1) ---
    let levelsSection = '';
    try {
      const base = String(trade.instrument).trim().split(/\s+/)[0].toUpperCase();
      const { rows: [lv] } = await pool.query(
        `SELECT levels FROM day_levels
         WHERE instrument = $2 AND trade_date BETWEEN $1::date - 1 AND $1::date + 1
         ORDER BY ABS(trade_date - $1::date) LIMIT 1`,
        [trade.trade_date, base]);
      const objs = (lv && lv.levels) || [];
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
Zones (${zones.length}): ${zones.join(', ') || 'none'}${trends.length ? `\nTrendlines (${trends.length}): ${trends.join(' | ')}` : ''}${nearTxt}`;
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

    const prompt = `You are a senior orderflow mentor reviewing one trade from a professional futures scalper's journal, working strictly in James Dalton's Auction Market Theory (Mind Over Markets / Markets in Profile). Judge it on evidence only — the orderflow, market profile, and the trader's own marked levels below. Accuracy over encouragement: if the read was right, say so plainly and cite what confirmed it; if it was wrong, say so plainly and cite what showed it. No hedging, no flattery, no generic advice. Cite specific times, prices, delta values, profile levels, and marked levels.

## Framework — Dalton AMT (use this vocabulary and logic)
- Start with Dalton's two questions: **which way is the market trying to go, and is it doing a good job of it?**
- The auction exists to facilitate trade. Value = the 70% value area where trade was accepted; POC = the fairest price.
- **Balance** (rotational, two-sided): responsive trades at the VA edges have edge; the target is rotation back toward POC / opposite edge.
- **Imbalance / one-timeframe** (range extension, value migrating, trend): fading is the classic error — trade with the other-timeframe (OTF) participant.
- **Initiative** = buying above value or selling below value (OTF conviction). **Responsive** = buying below value or selling above value (fading back to value).
- **Excess** (a tail at an extreme) = the auction finished properly; it is the reference responsive trades lean on. **Poor high/low** (flat, no tail) = unfinished business, expect it to be revisited.
- **Single prints** = aggressive one-timeframe activity; they act as later support/resistance.
- **IB and range extension**: the Initial Balance frames the early auction; extension beyond it signals OTF entry and argues against fading.
- **Location is the edge.** Mid-value is the lowest-quality location by construction. The high-quality references are VA edges, POC, IB extremes, single prints, excess tails, and the trader's own marked levels.

## This trader — a scalper (day timeframe; holds of seconds to minutes)
- A short hold is not itself a fault. An entry with no defined reference, or against one-timeframe direction, is.
- Entry must sit at a specific reference with a definable risk point; mid-value entries are low-edge regardless of how the orderflow looks.
- Targets should be the next auction reference (POC, opposite VA edge, IB extreme), not open-ended.
- Cardinal scalping errors: fading initiative/OTF activity, and entering mid-range with no reference.

## Trader's own terms (use exactly)
- "sell absorption" = buyers absorbing sellers; price holds/reverses up despite sell flow.
- "buy absorption" = sellers absorbing buyers; price holds/reverses down despite buy flow.
- "absorption" (unqualified) = passive side absorbing the aggressor at a level, blocking continuation.
- Tags follow group/name.

## Trade
${trade.instrument} | ${trade.direction} | Qty ${trade.quantity}
Entry ${fmtPx(trade.entry_price)} @ ${fmtUtc(entryUtcMs) || '?'} UTC | Exit ${trade.exit_price != null ? fmtPx(trade.exit_price) : 'open'} @ ${fmtUtc(exitUtcMs) || 'N/A'} UTC
Net P&L ${pnl} | Duration ${duration} | Tags ${tags || 'none'}
Notes: ${trade.description || 'none'}
${tickSection}${tpoSection}${levelsSection}

## Deliver (concise, evidence-first)
1. **Auction context** — answer Dalton's two questions. Balance or imbalance? Read the TPO letter sequence for value migration and one-timeframe activity, and say what day type was forming by entry. Where did entry sit vs VA / POC / IB, and what did cum delta show into it?
2. **Location** — was entry at a genuine reference (VA edge, POC, IB extreme, single print, excess tail, or one of the trader's marked levels) with a definable risk point, or mid-value with no reference? Did price actually react there per the orderflow (absorption, rejection, break)?
3. **Initiative vs responsive** — was this trade responsive or initiative, and was that the right choice for the auction state? Fading initiative/OTF activity is the cardinal error — call it out explicitly if that is what happened.
4. **Right or wrong** — verdict on the directional read, backed by orderflow + profile + level interaction. If right but mismanaged, say that.
5. **Better entry** — a higher-probability scalp in the window: cite the bar/time, the reference it sat on, and what confirmed it.
6. **Exit quality** — judged as a scalp: was there a logical auction target (POC / opposite VA edge / IB extreme), and was the exit at it, short of it, or a panic scratch? Do not penalize a short hold by itself.
7. **Key lesson** — one specific, actionable lesson, phrased in AMT terms.
8. **Score /10** — location quality, auction read, orderflow confirmation, exit management (9-10 exceptional; 7-8 good, minor flaws; 5-6 adequate w/ issues; 3-4 weak location or against one-timeframe direction; 0-2 fading OTF conviction / no reference / avoidable).

End with exactly this block, nothing after, one sentence per note:

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
    const child = spawn(claudePath, [
      '-p', '--no-session-persistence', '--model', 'claude-sonnet-4-6',
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
