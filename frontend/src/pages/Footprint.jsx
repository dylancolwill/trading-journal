import React, { useEffect, useState, useMemo, useRef } from 'react';
import { getFootprint, fetchFootprint } from '../api';
import { useTradeLevels } from '../levels';
import { CollapseToggle } from '../ui';

const BARS = [
  { label: '30s', v: 30 }, { label: '1m', v: 60 }, { label: '2m', v: 120 }, { label: '5m', v: 300 },
];
const SPEEDS = [
  { label: '1×', v: 1 }, { label: '3×', v: 3 }, { label: '5×', v: 5 }, { label: '10×', v: 10 },
];

function fmtTime(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'UTC' });
}
function fmtClock(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz || 'UTC' });
}

const CELL_MODES = [
  { label: 'Bid×Ask', v: 'bidask' }, { label: 'Total×Δ', v: 'totaldelta' },
];

// Diagonal imbalance threshold: a side is "imbalanced" when it's >= this many times the
// opposing volume one price level across the diagonal (buy vs the bid below, sell vs the ask above).
const IMBALANCE_RATIO = 2;

function partialGrid(ticks, cursor, barSeconds, tickSize) {
  const barMs = barSeconds * 1000;
  const grid = {};
  for (const tk of ticks) {
    if (tk.t > cursor) break;
    const barTs = Math.floor(tk.t / barMs) * barMs;
    const price = Math.round(tk.price / tickSize) * tickSize;
    const key = price.toFixed(8);
    if (!grid[barTs]) grid[barTs] = {};
    if (!grid[barTs][key]) grid[barTs][key] = [0, 0];
    if (tk.side === 'A') grid[barTs][key][0] += tk.size;
    else if (tk.side === 'B') grid[barTs][key][1] += tk.size;
  }
  return grid;
}

function computeCVD(ticks, barSeconds) {
  const barMs = barSeconds * 1000;
  const barMap = {};
  let cumDelta = 0;
  for (const tk of ticks) {
    const barTs = Math.floor(tk.t / barMs) * barMs;
    const d = tk.side === 'B' ? tk.size : -tk.size;
    if (!barMap[barTs]) barMap[barTs] = { open: cumDelta, high: cumDelta, low: cumDelta, close: cumDelta };
    cumDelta += d;
    barMap[barTs].close = cumDelta;
    if (cumDelta > barMap[barTs].high) barMap[barTs].high = cumDelta;
    if (cumDelta < barMap[barTs].low) barMap[barTs].low = cumDelta;
  }
  return barMap;
}

export default function Footprint({ tradeId }) {
  const [data, setData] = useState(null);
  const [bar, setBar] = useState(300);
  const [cellMode, setCellMode] = useState('bidask');
  const [showCVD, setShowCVD] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [replay, setReplay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState(true);
  const levels = useTradeLevels(tradeId);

  useEffect(() => {
    let alive = true;
    getFootprint(tradeId, bar).then(d => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [tradeId, bar]);

  const ticks = useMemo(() => {
    const t = (data && data.ticks) || [];
    return [...t].sort((a, b) => a.t - b.t);
  }, [data]);
  const tRange = useMemo(() => ticks.length ? [ticks[0].t, ticks[ticks.length - 1].t] : [0, 0], [ticks]);

  useEffect(() => { setCursor(tRange[0]); setPlaying(false); }, [replay, tRange[0]]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setCursor(c => {
        const next = c + speed * 120;
        if (next >= tRange[1]) { setPlaying(false); return tRange[1]; }
        return next;
      });
    }, 120);
    return () => clearInterval(id);
  }, [playing, speed, tRange]);

  const grab = async () => {
    setLoading(true); setErr('');
    try {
      const d = await fetchFootprint(tradeId, bar, hasData); // force=true when refreshing existing data
      setData(d);
    } catch (e) {
      setErr(e.message || 'Fetch failed');
    } finally {
      setLoading(false);
    }
  };

  const hasData = data && data.cached && data.bars && data.bars.length > 0;

  const view = useMemo(() => {
    if (!replay || !hasData) return data;
    const grid = partialGrid(ticks, cursor, data.bar_seconds, data.tick_size);
    const bars = data.bars.map(b => ({ ts: b.ts, cells: grid[b.ts] || {} }));
    const m = data.markers || {};
    const markers = {
      direction: m.direction,
      entry: (m.entry && cursor >= m.entry.ts) ? m.entry : null,
      exit: (m.exit && cursor >= m.exit.ts) ? m.exit : null,
    };
    return { ...data, bars, markers };
  }, [replay, hasData, data, ticks, cursor]);

  const cvdBars = useMemo(() => {
    if (!hasData || !showCVD) return {};
    const usedTicks = replay ? ticks.filter(tk => tk.t <= cursor) : ticks;
    return computeCVD(usedTicks, data.bar_seconds);
  }, [hasData, showCVD, replay, ticks, cursor, data]);

  const barMs = hasData ? data.bar_seconds * 1000 : 0;
  const activeBarTs = replay && barMs ? Math.floor(cursor / barMs) * barMs : null;
  const canReplay = hasData && ticks.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: collapsed ? 0 : 14, flexWrap: 'wrap' }}>
        <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} title="footprint chart" />
        <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Footprint Chart</div>
        {!collapsed && <>
        <div style={{ display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
          {BARS.map(b => (
            <button key={b.v} onClick={() => setBar(b.v)} style={{
              background: bar === b.v ? '#27272a' : 'transparent', border: 'none',
              color: bar === b.v ? '#e1e1e6' : '#52525b', padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>{b.label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
          {CELL_MODES.map(m => (
            <button key={m.v} onClick={() => setCellMode(m.v)} style={{
              background: cellMode === m.v ? '#27272a' : 'transparent', border: 'none',
              color: cellMode === m.v ? '#e1e1e6' : '#52525b', padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>{m.label}</button>
          ))}
        </div>
        <button onClick={() => setShowCVD(v => !v)} style={{
          background: showCVD ? '#27272a' : 'transparent', border: '1px solid #27272a', borderRadius: 6,
          color: showCVD ? '#e1e1e6' : '#52525b', padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
        }}>CVD</button>
        <button onClick={grab} disabled={loading} style={{
          background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6,
          padding: '6px 14px', cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, opacity: loading ? 0.6 : 1,
        }}>{loading ? 'Fetching…' : hasData ? 'Refresh data' : 'Grab data'}</button>
        {canReplay && (
          <button onClick={() => setReplay(r => !r)} style={{
            background: replay ? '#a78bfa' : 'transparent', color: replay ? '#1e1b4b' : '#a78bfa',
            border: '1px solid #a78bfa', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
          }}>{replay ? '✕ Exit replay' : '▶ Replay'}</button>
        )}
        {hasData && !replay && (
          <span style={{ fontSize: 11, color: '#52525b' }}>
            {data.symbol} · {data.tick_count.toLocaleString()} ticks · ${Number(data.cost).toFixed(5)}
          </span>
        )}
        {err && <span style={{ fontSize: 12, color: '#f87171' }}>{err}</span>}
        </>}
      </div>

      {!collapsed && replay && canReplay && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '10px 14px', flexWrap: 'wrap' }}>
          <button onClick={() => {
            if (cursor >= tRange[1]) setCursor(tRange[0]);
            setPlaying(p => !p);
          }} style={{
            background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6,
            width: 70, padding: '6px 0', cursor: 'pointer', fontWeight: 700, fontSize: 13,
          }}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <div style={{ display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
            {SPEEDS.map(s => (
              <button key={s.v} onClick={() => setSpeed(s.v)} style={{
                background: speed === s.v ? '#27272a' : 'transparent', border: 'none',
                color: speed === s.v ? '#e1e1e6' : '#52525b', padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>{s.label}</button>
            ))}
          </div>
          <input type="range" min={tRange[0]} max={tRange[1]} value={cursor} step={1000}
            onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }}
            style={{ flex: 1, minWidth: 160, accentColor: '#a78bfa' }} />
          <span style={{ fontSize: 12, color: '#a1a1aa', fontFamily: 'monospace', minWidth: 78, textAlign: 'right' }}>
            {fmtClock(cursor, data.display_tz)}
          </span>
          <button onClick={() => { setPlaying(false); setCursor(tRange[0]); }} style={{
            background: 'transparent', border: '1px solid #3f3f46', color: '#71717a', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12,
          }}>⟲ Reset</button>
        </div>
      )}

      {!collapsed && (!hasData ? (
        <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3f3f46' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
            <div style={{ fontSize: 13 }}>{data && data.cached === false ? 'No data yet — click "Grab data"' : 'Loading…'}</div>
          </div>
        </div>
      ) : (
        <FootprintGrid data={view} cellMode={cellMode} activeBarTs={activeBarTs} showCVD={showCVD} cvdBars={cvdBars} levels={levels} />
      ))}
    </div>
  );
}

function FootprintGrid({ data, cellMode, activeBarTs, showCVD, cvdBars, levels = [] }) {
  const decimals = (data.tick_size && data.tick_size < 0.01) ? 5 : 2;
  const cellW = 84;
  const labelW = 78;

  // Base rows = actual traded prices. Extend the grid toward nearby imported levels so
  // they land on a real row (footprint windows are narrow, so daily levels often sit just
  // outside the traded range). Extension is capped so the grid can't explode.
  const tick = data.tick_size || 0.25;
  const traded = data.prices.map(Number);
  const pMin = Math.min(...traded), pMax = Math.max(...traded);
  // Same margin as the candlestick chart (0.15× the visible range) — only pull in levels
  // sitting just outside the traded range.
  const maxExtend = (pMax - pMin) * 0.15;
  const lvlPrices = [];
  for (const o of levels) {
    if (o.kind === 'line' || o.kind === 'ray') lvlPrices.push(o.price);
    else if (o.kind === 'zone') lvlPrices.push(o.high, o.low);
  }
  let extLo = pMin, extHi = pMax;
  for (const p of lvlPrices) {
    if (p > pMax && p - pMax <= maxExtend) extHi = Math.max(extHi, p);
    else if (p < pMin && pMin - p <= maxExtend) extLo = Math.min(extLo, p);
  }
  const rowSet = new Map();
  for (const p of traded) rowSet.set(p.toFixed(8), p);
  // fill the extension bands (outside the traded range) with a tick grid
  for (let k = Math.round(extLo / tick); k <= Math.round(extHi / tick); k++) {
    const p = k * tick;
    if (p > pMin + 1e-9 && p < pMax - 1e-9) continue; // leave the traded region untouched
    rowSet.set(p.toFixed(8), p);
  }
  // guarantee every in-band level price has its own row to land on
  for (const p of lvlPrices) {
    if (p < extLo - 1e-9 || p > extHi + 1e-9) continue;
    const snapped = Math.round(p / tick) * tick;
    rowSet.set(snapped.toFixed(8), snapped);
  }
  const prices = [...rowSet.values()].sort((a, b) => b - a);

  const barMs = data.bar_seconds * 1000;
  const snap = (price) => {
    let best = null, bd = Infinity;
    for (const p of prices) { const d = Math.abs(p - price); if (d < bd) { bd = d; best = p; } }
    return best != null ? best.toFixed(8) : null;
  };

  // Map imported levels onto price rows. Horizontal lines/rays snap to their nearest
  // in-range row; zones tint every row inside their band. (Sloped trends are shown in
  // the legend only.) Timestamps are ignored here — the grid is price-indexed.
  const tol = (data.tick_size || 0) * 1.5;
  const linesByKey = {};
  for (const o of levels) {
    if (o.kind !== 'line' && o.kind !== 'ray') continue;
    const k = snap(o.price);
    if (k == null || Math.abs(Number(k) - o.price) > tol) continue;
    (linesByKey[k] = linesByKey[k] || []).push(o);
  }
  const zones = levels.filter(o => o.kind === 'zone');
  const zoneFor = (price) => zones.find(z => price <= z.high + 1e-9 && price >= z.low - 1e-9) || null;
  const markerFor = (m) => m ? { bar: Math.floor(m.ts / barMs) * barMs, key: snap(m.price) } : null;
  const entryM = markerFor(data.markers && data.markers.entry);
  const exitM = markerFor(data.markers && data.markers.exit);
  const isShort = data.markers && data.markers.direction === 'SHORT';
  const entryColor = isShort ? '#ef4444' : '#22c55e';
  const entryLabel = isShort ? 'S' : 'L';
  const badge = (barTs, key) => {
    const out = [];
    if (entryM && entryM.bar === barTs && entryM.key === key) out.push([entryLabel, entryColor]);
    if (exitM && exitM.bar === barTs && exitM.key === key) out.push(['E', '#f59e0b']);
    return out;
  };

  // CVD scale
  const CVD_H = 80;
  const cvdVals = showCVD ? data.bars.flatMap(b => {
    const c = cvdBars[b.ts];
    return c ? [c.open, c.close, c.high, c.low] : [];
  }) : [];
  const cvdMin = cvdVals.length ? Math.min(...cvdVals) : 0;
  const cvdMax = cvdVals.length ? Math.max(...cvdVals) : 1;
  const cvdRange = cvdMax - cvdMin || 1;
  const toY = (val) => ((cvdMax - val) / cvdRange) * CVD_H;
  const zeroY = (cvdMin < 0 && cvdMax > 0) ? toY(0) : null;

  return (
    <div style={{ overflowX: 'auto', background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'inline-block', minWidth: '100%' }}>
        {/* header */}
        <div style={{ display: 'flex' }}>
          <div style={{ width: labelW, flexShrink: 0 }} />
          {data.bars.map(b => (
            <div key={b.ts} style={{ width: cellW, flexShrink: 0, textAlign: 'center', fontSize: 11, color: b.ts === activeBarTs ? '#a78bfa' : '#71717a', fontWeight: b.ts === activeBarTs ? 800 : 600, paddingBottom: 6 }}>
              {fmtTime(b.ts, data.display_tz)}
            </div>
          ))}
        </div>

        {/* price rows */}
        {prices.map((price, pi) => {
          const key = price.toFixed(8);
          const belowKey = pi + 1 < prices.length ? prices[pi + 1].toFixed(8) : null; // one tick lower
          const aboveKey = pi - 1 >= 0 ? prices[pi - 1].toFixed(8) : null;             // one tick higher
          const rowLines = linesByKey[key] || [];
          const zoneHit = zoneFor(price);
          const rowStyle = {
            display: 'flex', alignItems: 'stretch',
            ...(zoneHit ? { background: `color-mix(in srgb, ${zoneHit.color} 15%, transparent)` } : {}),
            ...(rowLines.length ? { borderTop: `2px solid ${rowLines[0].color}` } : {}),
          };
          return (
            <div key={key} style={rowStyle}>
              <div style={{ width: labelW, flexShrink: 0, fontSize: 11, color: rowLines.length ? rowLines[0].color : '#a1a1aa', fontWeight: rowLines.length ? 700 : 400, fontFamily: 'monospace', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, paddingRight: 8 }}>
                {rowLines.map((o, i) => (
                  <span key={i} title={o.type} style={{ fontSize: 8, fontWeight: 800, color: '#09090b', background: o.color, borderRadius: 2, padding: '0 3px', lineHeight: '12px' }}>{o.label}</span>
                ))}
                {price.toFixed(decimals)}
              </div>
              {data.bars.map(b => {
                const marks = badge(b.ts, key);
                const markEl = marks.length > 0 && (
                  <span style={{ position: 'absolute', top: 1, right: 2, display: 'flex', gap: 2 }}>
                    {marks.map(([t, c]) => (
                      <span key={t} style={{ background: c, color: '#09090b', fontSize: 9, fontWeight: 800, borderRadius: 3, padding: '0 3px', lineHeight: '13px' }}>{t}</span>
                    ))}
                  </span>
                );
                const cell = b.cells[key];
                if (!cell) return (
                  <div key={b.ts} style={{ position: 'relative', width: cellW, flexShrink: 0, borderBottom: '1px solid #111', border: marks.length ? `1px solid ${marks[0][1]}` : undefined }}>
                    {markEl}
                  </div>
                );
                const [bid, ask] = cell;
                const delta = ask - bid;
                const total = ask + bid;
                const intensity = Math.min(1, 0.18 + total / 80);
                const bg = delta > 0 ? `rgba(16,120,40,${intensity})` : delta < 0 ? `rgba(150,25,25,${intensity})` : 'rgba(40,40,46,0.5)';

                // Diagonal imbalances (bid×ask mode): buys hit the ask, sells hit the bid, so
                // compare each side against the opposing volume one level across the diagonal.
                let buyImb = false, sellImb = false;
                if (cellMode === 'bidask') {
                  const bidBelow = (belowKey && b.cells[belowKey]) ? b.cells[belowKey][0] : 0;
                  const askAbove = (aboveKey && b.cells[aboveKey]) ? b.cells[aboveKey][1] : 0;
                  buyImb = ask > 0 && ask >= IMBALANCE_RATIO * Math.max(bidBelow, 1);
                  sellImb = bid > 0 && bid >= IMBALANCE_RATIO * Math.max(askAbove, 1);
                }
                const imb = (on, color) => on
                  ? { background: color, color: '#09090b', fontWeight: 800, borderRadius: 3, padding: '0 3px' }
                  : undefined;

                return (
                  <div key={b.ts} style={{
                    position: 'relative', width: cellW, flexShrink: 0, background: bg,
                    border: marks.length ? `2px solid ${marks[0][1]}` : '1px solid #1a1a1f',
                    fontSize: 11, color: '#e6e6e6', fontFamily: 'monospace', textAlign: 'center', padding: '3px 0',
                  }}>
                    {cellMode === 'totaldelta'
                      ? <>{total} <span style={{ color: '#71717a' }}>×</span> {delta >= 0 ? '+' : ''}{delta}</>
                      : <><span style={imb(sellImb, '#ef4444')}>{bid}</span> <span style={{ color: '#71717a' }}>x</span> <span style={imb(buyImb, '#22c55e')}>{ask}</span></>}
                    {markEl}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* CVD panel */}
        {showCVD && (
          <div style={{ display: 'flex', marginTop: 8, borderTop: '1px solid #27272a', paddingTop: 6 }}>
            {/* y-axis label */}
            <div style={{ width: labelW, flexShrink: 0, position: 'relative', height: CVD_H, fontSize: 9, fontFamily: 'monospace', color: '#52525b' }}>
              <span style={{ position: 'absolute', top: 0, right: 8 }}>{cvdMax > 0 ? '+' : ''}{cvdMax}</span>
              <span style={{ position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)', color: '#71717a', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>CVD</span>
              <span style={{ position: 'absolute', bottom: 0, right: 8 }}>{cvdMin}</span>
            </div>
            {/* candles */}
            <div style={{ position: 'relative', display: 'flex', flex: 1, height: CVD_H }}>
              {/* zero line */}
              {zeroY != null && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: zeroY, height: 1, background: '#3f3f46', borderTop: '1px dashed #3f3f46', pointerEvents: 'none', zIndex: 1 }} />
              )}
              {data.bars.map(b => {
                const cvd = cvdBars[b.ts];
                if (!cvd) return <div key={b.ts} style={{ width: cellW, flexShrink: 0, height: CVD_H }} />;

                const color = cvd.close >= cvd.open ? '#22c55e' : '#ef4444';
                const bodyTop = toY(Math.max(cvd.open, cvd.close));
                const bodyBot = toY(Math.min(cvd.open, cvd.close));
                const bodyH = Math.max(1, bodyBot - bodyTop);
                const wickTop = toY(cvd.high);
                const wickBot = toY(cvd.low);
                const wickH = Math.max(1, wickBot - wickTop);

                const delta = cvd.close - cvd.open;
                const deltaStr = (delta >= 0 ? '+' : '') + delta;

                return (
                  <div key={b.ts} style={{ width: cellW, flexShrink: 0, height: CVD_H, position: 'relative' }}>
                    {/* wick */}
                    <div style={{ position: 'absolute', left: '50%', top: wickTop, width: 1, height: wickH, background: color, transform: 'translateX(-50%)' }} />
                    {/* body */}
                    <div style={{ position: 'absolute', left: '25%', right: '25%', top: bodyTop, height: bodyH, background: color, borderRadius: 1, opacity: 0.9 }} />
                    {/* delta label */}
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center', fontSize: 9, fontWeight: 700, fontFamily: 'monospace', color, lineHeight: 1.2 }}>
                      {deltaStr}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#52525b', marginTop: 8 }}>
        cells: {cellMode === 'totaldelta' ? 'total × delta' : 'bid × ask'} · green = net buying · red = net selling
        {cellMode === 'bidask' && <> · highlighted = diagonal imbalance ≥{IMBALANCE_RATIO}× (buy on ask / sell on bid)</>}
        {showCVD && ' · CVD = cumulative volume delta'}
      </div>
    </div>
  );
}
