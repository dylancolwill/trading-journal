import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { mdComponents } from '../markdown';
import {
  getInsightsSummary, getInsightReports, getInsightReport, deleteInsightReport,
  insightsAnalyzeUrl, getInstruments,
} from '../api';

const PERIODS = [['7', '7d'], ['14', '14d'], ['30', '30d'], ['90', '90d'], ['180', '180d'], ['all', 'All']];
const POS = '#22c55e', NEG = '#ef4444', MUTED = '#52525b', ACCENT = '#a78bfa';

const money = n => (n == null ? '–' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const moneyShort = n => {
  if (n == null) return '–';
  const a = Math.abs(n);
  return (n < 0 ? '−' : '') + (a >= 10000 ? `$${(a / 1000).toFixed(1)}k` : `$${a.toFixed(a >= 100 ? 0 : 2)}`);
};
const pnlColor = n => (n == null ? '#a1a1aa' : n > 0 ? POS : n < 0 ? NEG : '#a1a1aa');
const dur = s => (s == null ? '–' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`);
const fmtDay = d => (d ? d.slice(8, 10) + '-' + d.slice(5, 7) + '-' + d.slice(0, 4) : '–');
const pts = (ticks, tick) => +(ticks * tick).toFixed(4);
// A read-rate needs enough decided trades before it means anything.
const MIN_READS = 8;

const card = { background: '#18181b', border: '1px solid #27272a', borderRadius: 10 };
const num = { fontVariantNumeric: 'tabular-nums' };
const h3 = { fontSize: 12, fontWeight: 700, color: '#e1e1e6', marginBottom: 2 };
const sub = { fontSize: 11, color: '#52525b', marginBottom: 10 };

function Stat({ label, value, color, sub: note, hero }) {
  return (
    <div style={{ ...card, padding: hero ? '16px 18px' : '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: hero ? 30 : 20, fontWeight: 700, color: color || '#e1e1e6', lineHeight: 1.1 }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: '#52525b', marginTop: 5, ...num }}>{note}</div>}
    </div>
  );
}

// One headline finding from the measured execution data: the number, what it means, and a
// one-line interpretation.
function Finding({ title, value, color, detail, verdict, verdictTone, children }) {
  const toneColor = verdictTone === 'bad' ? '#f87171' : verdictTone === 'good' ? '#4ade80' : '#a1a1aa';
  return (
    <div style={{ ...card, padding: '14px 16px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || '#e1e1e6', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 6, lineHeight: 1.5, ...num }}>{detail}</div>
      {children}
      {verdict && <div style={{ fontSize: 12, color: toneColor, marginTop: 8, fontWeight: 600 }}>{verdict}</div>}
    </div>
  );
}

// Correct vs incorrect reads as one split bar, direct-labelled.
function ReadsBar({ correct, incorrect }) {
  const total = correct + incorrect;
  if (!total) return null;
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, marginTop: 10 }}
      title={`${correct} right, ${incorrect} wrong`}>
      <div style={{ width: `${(correct / total) * 100}%`, background: POS }} />
      <div style={{ width: `${(incorrect / total) * 100}%`, background: NEG }} />
    </div>
  );
}

// Stop × target what-if. Colour is the difference from the actual result (a diverging
// scale centred on "same as actual"); the dollar value is printed in every cell.
function WhatIfGrid({ e }) {
  const tick = e.tick_pts;
  const deltas = e.grid.map(c => c.net - e.actual_net);
  const maxAbs = Math.max(...deltas.map(Math.abs), 1);
  const cellFor = (s, t) => e.grid.find(c => c.stop_ticks === s && c.target_ticks === t);
  const isBest = c => c.stop_ticks === e.best.stop_ticks && c.target_ticks === e.best.target_ticks;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 3, fontSize: 12, ...num }}>
        <thead>
          <tr>
            <th style={{ color: '#52525b', fontWeight: 600, fontSize: 11, textAlign: 'left', padding: '0 8px 4px 0' }}>stop ↓ · target →</th>
            {e.targets.map(t => <th key={t} style={{ color: '#71717a', fontWeight: 600, padding: '0 0 4px', minWidth: 76 }}>{pts(t, tick)} pts</th>)}
          </tr>
        </thead>
        <tbody>
          {e.stops.map(s => (
            <tr key={s}>
              <td style={{ color: '#71717a', fontWeight: 600, paddingRight: 8, whiteSpace: 'nowrap' }}>{pts(s, tick)} pts</td>
              {e.targets.map(t => {
                const c = cellFor(s, t);
                const d = c.net - e.actual_net;
                const a = 0.1 + 0.55 * (Math.abs(d) / maxAbs);
                const bg = d >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`;
                return (
                  <td key={t} title={`Stop ${pts(s, tick)} / target ${pts(t, tick)} pts: ${money(c.net)} (${d >= 0 ? '+' : '−'}${moneyShort(Math.abs(d))} vs actual), ${c.win_rate}% hit target`}
                    style={{ background: bg, borderRadius: 5, padding: '7px 6px', textAlign: 'center', color: '#e1e1e6', fontWeight: isBest(c) ? 700 : 500,
                      outline: isBest(c) ? '2px solid #e1e1e6' : 'none', outlineOffset: -2 }}>
                    {moneyShort(c.net)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DivergingRow({ row, max }) {
  const value = row.net;
  const frac = max > 0 ? Math.min(1, Math.abs(value) / max) : 0;
  const reads = row.reads_decided >= 1 ? row.reads_right_pct : null;
  const thin = row.reads_decided < MIN_READS;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px 70px 92px', alignItems: 'center', gap: 10, padding: '3px 0' }}
      title={`${row.key} — ${row.trades} trades, ${row.win_rate}% win, net ${money(value)}${reads == null ? '' : `, reads right ${reads}% of ${row.reads_decided}`}`}>
      <div style={{ fontSize: 12, color: '#d4d4d8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.key}</div>
      <div style={{ position: 'relative', height: 14 }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#3f3f46' }} />
        <div style={{
          position: 'absolute', top: 2, height: 10, width: `${frac * 50}%`, background: value < 0 ? NEG : POS, opacity: 0.85,
          ...(value < 0 ? { right: '50%', borderRadius: '4px 0 0 4px' } : { left: '50%', borderRadius: '0 4px 4px 0' }),
        }} />
      </div>
      <div style={{ fontSize: 11, textAlign: 'right', color: pnlColor(value), fontWeight: 600, ...num }}>{moneyShort(value)}</div>
      <div style={{ fontSize: 11, textAlign: 'right', color: reads == null ? '#3f3f46' : thin ? '#71717a' : reads >= 50 ? '#4ade80' : '#f87171', ...num }}>
        {reads == null ? '–' : `${reads}%`}<span style={{ color: '#3f3f46' }}> /{row.reads_decided}</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows, note, limit }) {
  if (!rows || !rows.length) return null;
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(...shown.map(r => Math.abs(r.net)), 1);
  return (
    <div style={{ ...card, padding: '14px 16px' }}>
      <div style={h3}>{title}</div>
      <div style={sub}>{note || 'net P&L · reads right / decided'}</div>
      {shown.map(r => <DivergingRow key={r.key} row={r} max={max} />)}
      {limit && rows.length > limit && <div style={{ fontSize: 11, color: '#3f3f46', marginTop: 8 }}>+{rows.length - limit} more not shown</div>}
    </div>
  );
}

// Plain-language reading of the what-if grid, derived from the same numbers it shows.
function gridReading(e) {
  const rowAvg = s => { const r = e.grid.filter(c => c.stop_ticks === s); return r.reduce((a, c) => a + c.net, 0) / r.length; };
  const tight = e.stops[0], wide = e.stops[e.stops.length - 1];
  const tightRow = e.grid.filter(c => c.stop_ticks === tight);
  return {
    allNegative: e.grid.every(c => c.net < 0),
    widerWorse: rowAvg(wide) < rowAvg(tight),
    biggerTargetsHelp: tightRow[tightRow.length - 1].net > tightRow[0].net,
  };
}

export default function AIAnalysis() {
  const [days, setDays] = useState('30');
  const [instrument, setInstrument] = useState('');
  const [instruments, setInstruments] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const [report, setReport] = useState('');
  const [status, setStatus] = useState('');
  const [stage, setStage] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [viewing, setViewing] = useState(null);
  const timer = useRef(null);

  useEffect(() => { getInstruments().then(setInstruments).catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    getInsightsSummary(days, instrument)
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days, instrument]);

  const loadHistory = () => getInsightReports(20).then(setHistory).catch(() => {});
  useEffect(() => { loadHistory(); }, []);
  useEffect(() => () => clearInterval(timer.current), []);

  const openReport = async (id) => {
    try { const r = await getInsightReport(id); setReport(r.report); setViewing(id); setError(''); setStatus(''); }
    catch (e) { setError(e.message); }
  };
  const removeReport = async (id) => {
    if (!confirm('Delete this report?')) return;
    await deleteInsightReport(id);
    if (viewing === id) { setReport(''); setViewing(null); }
    loadHistory();
  };

  const generate = async () => {
    setStatus('generating'); setStage('Gathering trades…'); setError(''); setReport(''); setViewing(null); setElapsed(0);
    const startedAt = Date.now();
    clearInterval(timer.current);
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    try {
      const response = await fetch(insightsAnalyzeUrl(days, instrument), { method: 'POST' });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || `Server error ${response.status}`); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let d; try { d = JSON.parse(line.slice(6)); } catch { continue; }
          if (d.stage) setStage(d.stage);
          if (typeof d.elapsed === 'number') setElapsed(d.elapsed);
          if (d.text) { setReport(prev => prev + d.text); setStage('Writing report…'); }
          else if (d.done) { setStage(''); setStatus('saved'); setViewing(d.id); loadHistory(); setTimeout(() => setStatus(''), 2500); }
          else if (d.error) throw new Error(d.error);
        }
      }
    } catch (e) { setStatus(''); setStage(''); setError(e.message || 'Unknown error — check server logs'); }
    finally { clearInterval(timer.current); }
  };

  const s = data && data.stats;
  const o = s && s.overall;
  const e = s && s.execution;
  const busy = status === 'generating';
  const g = e && e.measured ? gridReading(e) : null;

  return (
    <div style={{ padding: 24, maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>AI Analysis</h2>
          <p style={{ color: '#52525b', fontSize: 13, marginTop: 4 }}>
            Where the money goes, measured from your fills and tick data.
            {data && data.from && <span> · {fmtDay(data.from)} → {fmtDay(data.to)}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={instrument} onChange={ev => setInstrument(ev.target.value)}
            style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', padding: '6px 10px', fontSize: 12 }}>
            <option value="">All instruments</option>
            {instruments.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
          <div style={{ display: 'flex', background: '#18181b', border: '1px solid #27272a', borderRadius: 7, overflow: 'hidden' }}>
            {PERIODS.map(([v, label]) => (
              <button key={v} onClick={() => setDays(v)} style={{
                background: days === v ? '#27272a' : 'transparent', border: 'none', cursor: 'pointer',
                color: days === v ? '#e1e1e6' : '#71717a', padding: '6px 12px', fontSize: 12, fontWeight: 600,
              }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div style={{ color: '#3f3f46', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>Loading…</div>}
      {!loading && o && o.trades === 0 && (
        <div style={{ ...card, padding: 48, textAlign: 'center', color: '#3f3f46', marginTop: 18 }}>No trades in this period. Pick a wider range.</div>
      )}

      {!loading && o && o.trades > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, margin: '18px 0 18px' }}>
            <Stat hero label="Net P&L" value={money(o.net)} color={pnlColor(o.net)} sub={`${o.closed} closed trades`} />
            <Stat label="Win rate" value={`${o.win_rate}%`} sub={`${o.wins}W / ${o.losses}L${o.scratches ? ` / ${o.scratches}S` : ''}`} />
            <Stat label="Avg win / avg loss" value={`${moneyShort(o.avg_win)} / ${moneyShort(o.avg_loss)}`} sub={`profit factor ${o.profit_factor ?? '–'}`} />
            <Stat label="Expectancy" value={money(o.expectancy)} color={pnlColor(o.expectancy)} sub={`per trade · fees ${moneyShort(o.commission)}`} />
            <Stat label="NY sessions" value={s.day_stats.days} sub={`${s.day_stats.green_days} green · ${s.day_stats.red_days} red · ${s.day_stats.avg_trades_per_day}/session`} />
          </div>

          {e && e.measured > 0 ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Execution</div>
                <div style={{ fontSize: 11, color: '#52525b' }}>
                  measured tick-by-tick on {e.measured} of {e.of} trades · "normal minute" = median 1-min range around your entries ({e.noise_1m} pts)
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 10 }}>
                <Finding title="Reads — which way price went first"
                  value={`${e.direction.correct_pct}% right`}
                  color={e.direction.correct_pct >= 50 ? POS : NEG}
                  detail={<>Price travelled two normal minutes' range your way first on <strong>{e.direction.correct}</strong>, against you first on <strong>{e.direction.incorrect}</strong>. {e.direction.partial} went nowhere.</>}
                  verdict={e.direction.decided < MIN_READS ? 'Too few decided trades to judge yet.'
                    : e.direction.correct_pct >= 55 ? 'Your reads have an edge.' : e.direction.correct_pct > 45 ? 'Reads are close to a coin flip.' : 'Reads are wrong more often than right — entry selection is the main lever.'}
                  verdictTone={e.direction.decided < MIN_READS ? null : e.direction.correct_pct >= 55 ? 'good' : 'bad'}>
                  <ReadsBar correct={e.direction.correct} incorrect={e.direction.incorrect} />
                </Finding>

                <Finding title="Exits on winners"
                  value={e.winners ? `${Math.round((e.capture_median || 0) * 100)}% kept` : '–'}
                  color={e.capture_median >= 0.5 ? POS : NEG}
                  detail={e.winners
                    ? <>Median <strong>{e.captured_pts_median} pts</strong> kept of <strong>{e.available_pts_median} pts</strong> available within 15 min. {e.winners_under_third} of {e.winners} winners kept under a third.</>
                    : 'No measured winners in this period.'}
                  verdict={e.winners ? (e.capture_median < 1 / 3 ? 'Winners are cut far short of the move.' : 'Winners are held reasonably well.') : null}
                  verdictTone={e.winners ? (e.capture_median < 1 / 3 ? 'bad' : 'good') : null} />

                <Finding title="Stops vs normal noise"
                  value={e.losers ? `${e.stop_median} pt stop` : '–'}
                  detail={e.losers
                    ? <>Median stop is <strong>{e.stop_vs_noise_median}×</strong> one normal minute. {e.losers_inside_noise} of {e.losers} losers were stopped inside a normal minute's range; {e.right_idea_losers} of them had the direction right.</>
                    : 'No measured losers in this period.'}
                  verdict={g ? (g.widerWorse ? 'Wider stops would have lost more — tight stops are limiting damage.' : 'Wider stops would have done better — stops inside noise are costing you.') : null}
                  verdictTone={g ? (g.widerWorse ? 'good' : 'bad') : null} />
              </div>

              <div style={{ ...card, padding: '14px 16px', marginBottom: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: '1 1 380px' }}>
                    <div style={h3}>What if: same entries, fixed stop and target</div>
                    <div style={sub}>Net P&L on the same {e.measured} trades, size and fees — only the exit plan changes. Green beats your actual result, red does worse.</div>
                    <WhatIfGrid e={e} />
                  </div>
                  <div style={{ flex: '1 1 260px', fontSize: 12, color: '#a1a1aa', lineHeight: 1.6 }}>
                    <div style={{ marginBottom: 8 }}>Actual result: <strong style={{ color: pnlColor(e.actual_net) }}>{money(e.actual_net)}</strong></div>
                    <div style={{ marginBottom: 8 }}>
                      Best: stop {pts(e.best.stop_ticks, e.tick_pts)} / target {pts(e.best.target_ticks, e.tick_pts)} pts →{' '}
                      <strong style={{ color: pnlColor(e.best.net) }}>{money(e.best.net)}</strong>{' '}
                      ({e.best.net - e.actual_net >= 0 ? '+' : '−'}{moneyShort(Math.abs(e.best.net - e.actual_net))} vs actual)
                    </div>
                    <ul style={{ margin: '0 0 8px', paddingLeft: 16 }}>
                      <li>{g.allNegative ? 'No exit plan makes these entries profitable — the entries are the bigger lever.' : 'Some exit plans turn these same entries profitable.'}</li>
                      <li>{g.widerWorse ? 'Giving trades more room loses more.' : 'Giving trades more room helps.'}</li>
                      <li>{g.biggerTargetsHelp ? 'Bigger targets help: winners are being cut short.' : 'Bigger targets don\'t help at this stop.'}</li>
                    </ul>
                    <div style={{ fontSize: 11, color: '#52525b' }}>No slippage; each trade closed at 15 min if neither level is hit. Hindsight on the exit plan only — the entries are yours.</div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ ...card, padding: '14px 16px', marginBottom: 18, fontSize: 12, color: '#71717a' }}>
              No trades in this period have tick data, so execution can't be measured. Open a trade's footprint to download its ticks — they're measured automatically.
            </div>
          )}

          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Where it works and where it doesn't</div>
          <div style={{ fontSize: 11, color: '#52525b', marginBottom: 10 }}>
            Right column: how often your read was right / decided trades. Grey when fewer than {MIN_READS} decided — too few to trust.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 10, marginBottom: 10 }}>
            <Breakdown title="Timing vs the 09:30 ET open" rows={s.by_timing} />
            <Breakdown title="By side" rows={s.by_direction} />
            <Breakdown title="By your tags" rows={s.by_tag} limit={12} note="worst net first · a trade can carry several tags" />
            <Breakdown title="By half-hour (New York)" rows={s.by_hour} note="09:00 is pre-market · 09:30 is the cash open" />
            <Breakdown title="By weekday" rows={s.by_dow} />
            <Breakdown title="By instrument" rows={s.by_instrument} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 10, marginBottom: 18 }}>
            <div style={{ ...card, padding: '14px 16px' }}>
              <div style={h3}>Session load</div>
              <div style={sub}>NY sessions grouped by how many trades you took</div>
              {s.day_stats.by_load.map(l => (
                <div key={l.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #27272a', ...num }}>
                  <span style={{ color: '#d4d4d8' }}>{l.key}</span>
                  <span style={{ color: '#71717a' }}>{l.days} sessions · <strong style={{ color: pnlColor(l.avg_day_net) }}>{money(l.avg_day_net)}</strong> per session</span>
                </div>
              ))}
            </div>
            <div style={{ ...card, padding: '14px 16px' }}>
              <div style={h3}>After a loss</div>
              <div style={sub}>trades opened within {s.after_loss.within_min} min of closing a loss</div>
              {s.after_loss.closed ? (
                <div style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.6, ...num }}>
                  {s.after_loss.closed} trades · {s.after_loss.win_rate}% win · net <strong style={{ color: pnlColor(s.after_loss.net) }}>{money(s.after_loss.net)}</strong><br />
                  {money(s.after_loss.expectancy)} per trade vs {money(o.expectancy)} overall{' '}
                  {s.after_loss.expectancy < o.expectancy
                    ? <span style={{ color: '#f87171' }}>— worse than your average</span>
                    : <span style={{ color: '#4ade80' }}>— no worse than your average</span>}
                  <div style={{ marginTop: 6, fontSize: 11, color: '#52525b' }}>
                    Hold time: winners {dur(s.hold_seconds.avg_win)}, losers {dur(s.hold_seconds.avg_loss)} · streaks {s.max_win_streak}W / {s.max_loss_streak}L
                  </div>
                </div>
              ) : <div style={{ fontSize: 12, color: '#52525b' }}>None in this period.</div>}
            </div>
          </div>
        </>
      )}

      <div style={{ ...card, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Coach's review</div>
            <div style={{ fontSize: 12, color: '#52525b', marginTop: 2 }}>
              {o ? `Reads the numbers above plus your notes and tags across ${o.trades} trades, and ranks what to change by dollar impact.` : 'Pick a period above.'}
            </div>
          </div>
          <button onClick={generate} disabled={busy || !o || o.trades < 5} style={{
            background: busy ? '#27272a' : ACCENT, color: busy ? '#71717a' : '#1e1b4b', border: 'none', borderRadius: 7,
            padding: '9px 18px', fontWeight: 700, fontSize: 13,
            cursor: busy || !o || o.trades < 5 ? 'default' : 'pointer', opacity: !o || o.trades < 5 ? 0.5 : 1,
          }}>{busy ? `Analysing… ${elapsed}s` : report ? 'Regenerate' : 'Generate review'}</button>
        </div>

        {busy && stage && <div style={{ fontSize: 12, color: ACCENT, marginBottom: 12 }}>{stage} <span style={{ color: '#52525b' }}>· {elapsed}s</span></div>}
        {status === 'saved' && <div style={{ fontSize: 12, color: POS, marginBottom: 12 }}>Saved to history.</div>}
        {error && (
          <div style={{ background: '#2a0f0f', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#fca5a5' }}>
            <strong style={{ color: '#f87171' }}>Review failed:</strong> {error}
          </div>
        )}
        {report ? (
          <div style={{ color: '#e1e1e6', fontSize: 13, lineHeight: 1.7 }}>
            <ReactMarkdown components={mdComponents}>{report}</ReactMarkdown>
            {busy && <span style={{ display: 'inline-block', width: 8, height: 14, background: ACCENT, borderRadius: 2, verticalAlign: 'text-bottom', marginLeft: 2 }} />}
          </div>
        ) : !busy && (
          <div style={{ color: '#3f3f46', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
            {o && o.trades < 5 ? 'Not enough trades in this period.' : 'No review yet for this period.'}
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Past reviews</div>
          {history.map(h => (
            <div key={h.id} onClick={() => openReport(h.id)} style={{ ...card, padding: '10px 14px', marginBottom: 8, cursor: 'pointer', borderColor: viewing === h.id ? ACCENT : '#27272a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e1e1e6' }}>
                  {h.period_label}{h.instrument ? ` · ${h.instrument}` : ''}
                  <span style={{ color: '#52525b', fontWeight: 400, fontSize: 11 }}> · {h.trade_count} trades · {fmtDay(String(h.from_date))} → {fmtDay(String(h.to_date))}</span>
                </span>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
                  {h.trend && (
                    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
                      color: h.trend === 'improving' ? POS : h.trend === 'declining' ? NEG : '#a1a1aa',
                      background: (h.trend === 'improving' ? POS : h.trend === 'declining' ? NEG : MUTED) + '18' }}>{h.trend}</span>
                  )}
                  <span style={{ fontSize: 11, color: '#3f3f46' }}>{String(h.created_at).slice(0, 10)}</span>
                  <button onClick={ev => { ev.stopPropagation(); removeReport(h.id); }}
                    style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 5, color: '#71717a', fontSize: 10, padding: '1px 7px', cursor: 'pointer' }}>Delete</button>
                </span>
              </div>
              {h.top_mistake && <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 5 }}><strong style={{ color: '#71717a' }}>Top mistake:</strong> {h.top_mistake}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
