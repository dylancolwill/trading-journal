const express = require('express');
const { spawn } = require('child_process');
const { pool } = require('../db');
const { summarize } = require('../lib/insights');
const { buildReportPrompt } = require('../lib/insightsPrompt');
const { sameFamily } = require('../lib/symbols');
const { ensureExecution, getExecution } = require('../lib/executionStore');
const { ticksForTrade } = require('./footprint');

const router = express.Router();

// Periods the page offers. null days = everything on record.
const PERIODS = {
  7: 'Last 7 days', 14: 'Last 14 days', 30: 'Last 30 days', 90: 'Last 90 days', 180: 'Last 180 days',
};
const ALL_LABEL = 'All time';

function periodOf(req) {
  const raw = String(req.query.days ?? '30').toLowerCase();
  if (raw === 'all' || raw === '0') return { days: null, label: ALL_LABEL };
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0) return { days: 30, label: PERIODS[30] };
  return { days, label: PERIODS[days] || `Last ${days} days` };
}

// Trades in the window, with their tags, newest first. Instrument filter matches the whole
// contract family, so asking for ES includes the MES executions.
async function loadTrades({ days, instrument }) {
  const { rows } = await pool.query(
    `SELECT t.*,
            COALESCE(json_agg(DISTINCT jsonb_build_object('name', tg.name, 'group_name', tg.group_name))
              FILTER (WHERE tg.id IS NOT NULL), '[]') AS tags
     FROM trades t
     LEFT JOIN trade_tags tt ON tt.trade_id = t.id
     LEFT JOIN tags tg ON tg.id = tt.tag_id
     WHERE ($1::int IS NULL OR t.trade_date >= CURRENT_DATE - $1::int)
     GROUP BY t.id
     ORDER BY t.trade_date DESC, t.entry_time DESC`,
    [days]
  );
  return instrument ? rows.filter(t => sameFamily(t.instrument, instrument)) : rows;
}

const dateRange = trades => {
  const dates = trades.map(t => String(t.trade_date).slice(0, 10)).sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null };
};

// Measured execution metrics for these trades — computing any whose ticks are still cached
// but haven't been measured yet (cheap: already-measured trades are skipped).
async function executionFor(trades) {
  const ids = trades.filter(t => t.net_pnl != null).map(t => t.id);
  await ensureExecution(ids, ticksForTrade);
  return getExecution(ids);
}

// GET /api/insights/summary?days=30&instrument=ES -> the aggregate tables, no AI, no cost
router.get('/summary', async (req, res) => {
  try {
    const { days, label } = periodOf(req);
    const instrument = (req.query.instrument || '').trim();
    const trades = await loadTrades({ days, instrument });
    const { from, to } = dateRange(trades);
    const exec = await executionFor(trades);
    res.json({ period_label: label, period_days: days, instrument, from, to, stats: summarize(trades, exec) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/insights/reports?limit=20 -> past reports, newest first (list view, no body)
router.get('/reports', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      `SELECT id, period_label, period_days, from_date, to_date, trade_count, instrument,
              top_mistake, biggest_leak, first_fix, trend, model, created_at
       FROM ai_reports ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/insights/reports/:id -> one full report
router.get('/reports/:id', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query('SELECT * FROM ai_reports WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/insights/analyze?days=30&instrument=ES -> SSE stream of the period review.
// Same transport as the per-trade analyze endpoint: {stage}, {elapsed}, {text}, {done}.
router.post('/analyze', async (req, res) => {
  const { days, label } = periodOf(req);
  const instrument = (req.query.instrument || '').trim();
  console.log(`[insights] START days=${days ?? 'all'} instrument=${instrument || 'all'}`);

  try {
    const trades = await loadTrades({ days, instrument });
    if (trades.length < 5) {
      return res.status(400).json({ error: `Only ${trades.length} trades in this period — not enough to find a pattern. Widen the range.` });
    }

    const exec = await executionFor(trades);
    const stats = summarize(trades, exec);
    const { from, to } = dateRange(trades);
    const prompt = buildReportPrompt({ stats, trades, exec, from, to, label });
    console.log(`[insights] ${trades.length} trades, prompt ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': ping\n\n');

    let fullText = '';
    let thinkingChars = 0;
    const t0 = Date.now();
    res.write(`data: ${JSON.stringify({ stage: `Reading ${trades.length} trades…`, elapsed: 0 })}\n\n`);

    // Progress ticks double as the keep-alive: the reasoning phase emits no answer text, so
    // surface thinking volume instead or the UI looks frozen.
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (fullText) return res.write(`data: ${JSON.stringify({ elapsed })}\n\n`);
      const approx = Math.round(thinkingChars / 4);
      res.write(`data: ${JSON.stringify({
        elapsed,
        stage: approx ? `Model is reasoning… ~${approx.toLocaleString()} thinking tokens` : 'Model is reasoning…',
      })}\n\n`);
    }, 5000);

    // A period review is a bigger synthesis than a single trade and runs far less often, so
    // it defaults to a higher effort than the per-trade reviewer.
    const model = process.env.INSIGHTS_MODEL || process.env.ANALYZE_MODEL || 'claude-sonnet-5';
    const effort = process.env.INSIGHTS_EFFORT || 'high';
    const effortArgs = effort === 'none' ? [] : ['--effort', effort];
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const child = spawn(claudePath, [
      '-p', '--no-session-persistence', '--model', model,
      ...effortArgs,
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[insights] spawned pid=${child.pid} model=${model} effort=${effort}`);

    child.on('error', err => {
      clearInterval(heartbeat);
      console.error('[insights] spawn error:', err.message);
      res.write(`data: ${JSON.stringify({ error: `Failed to start claude: ${err.message}` })}\n\n`);
      res.end();
    });

    let ndjson = '';
    let writing = false;
    child.stdout.on('data', chunk => {
      ndjson += chunk.toString();
      const lines = ndjson.split('\n');
      ndjson = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'result' && ev.usage) {
          const u = ev.usage;
          const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          console.log(`[insights] USAGE in=${inTok} out=${u.output_tokens || 0} cost=$${(ev.total_cost_usd || 0).toFixed(4)}`);
        }
        if (ev.type === 'result' && !fullText && typeof ev.result === 'string') {
          fullText = ev.result;
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
              console.log(`[insights] first text after ${Math.round((Date.now() - t0) / 1000)}s`);
              res.write(`data: ${JSON.stringify({ stage: 'Writing report…' })}\n\n`);
            }
            fullText += text;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }
      }
    });

    child.stderr.on('data', d => console.error('[insights] claude stderr:', d.toString()));

    child.on('close', async code => {
      clearInterval(heartbeat);
      console.log(`[insights] closed code=${code} textLen=${fullText.length}`);
      if (code !== 0 || !fullText.trim()) {
        res.write(`data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`);
        return res.end();
      }
      const pick = re => { const m = fullText.match(re); return m ? m[1].trim() : null; };
      const topMistake = pick(/^TOP MISTAKE:\s*(.+)$/im);
      const biggestLeak = pick(/^BIGGEST LEAK:\s*(.+)$/im);
      const firstFix = pick(/^FIRST FIX:\s*(.+)$/im);
      const trend = pick(/^TREND:\s*(improving|flat|declining)\b/im);

      try {
        const { rows: [row] } = await pool.query(
          `INSERT INTO ai_reports
            (period_label, period_days, from_date, to_date, trade_count, instrument,
             report, top_mistake, biggest_leak, first_fix, trend, stats, model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
           RETURNING id, created_at`,
          [label, days, from, to, trades.length, instrument, fullText.trim(),
           topMistake, biggestLeak, firstFix, trend ? trend.toLowerCase() : null,
           JSON.stringify(stats), model]
        );
        res.write(`data: ${JSON.stringify({
          done: true, id: row.id, created_at: row.created_at,
          top_mistake: topMistake, biggest_leak: biggestLeak, first_fix: firstFix,
          trend: trend ? trend.toLowerCase() : null,
        })}\n\n`);
      } catch (e) {
        console.error('[insights] save failed:', e.message);
        res.write(`data: ${JSON.stringify({ error: `Report generated but saving failed: ${e.message}` })}\n\n`);
      }
      res.end();
    });

    req.on('close', () => { clearInterval(heartbeat); child.kill(); });
  } catch (err) {
    console.error('[insights]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

module.exports = router;
