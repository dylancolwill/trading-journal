import React, { useEffect, useState, useId } from 'react';
import { getCandles, fetchCandles } from '../api';
import { useTradeLevels } from '../levels';
import { CollapseToggle } from '../ui';

function fmtTime(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'UTC' });
}

const TFS = [
  { label: '1m', v: 60 }, { label: '2m', v: 120 }, { label: '5m', v: 300 }, { label: '15m', v: 900 },
];

// aggregate cached 1-min candles into a higher timeframe (no extra fetch)
function aggregate(candles, tfSec) {
  if (tfSec <= 60) return candles;
  const tfMs = tfSec * 1000;
  const buckets = {};
  for (const c of candles) {
    const b = Math.floor(c.t / tfMs) * tfMs;
    if (!buckets[b]) buckets[b] = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    else { const k = buckets[b]; k.h = Math.max(k.h, c.h); k.l = Math.min(k.l, c.l); k.c = c.c; k.v += c.v; }
  }
  return Object.values(buckets).sort((a, b) => a.t - b.t);
}

export default function Candles({ tradeId }) {
  const [data, setData] = useState(null);
  const [tf, setTf] = useState(300);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [collapsed, setCollapsed] = useState(true);
  const levels = useTradeLevels(tradeId);

  useEffect(() => {
    let alive = true;
    getCandles(tradeId).then(d => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [tradeId]);

  const grab = async () => {
    setLoading(true); setErr('');
    try { setData(await fetchCandles(tradeId)); }
    catch (e) { setErr(e.message || 'Fetch failed'); }
    finally { setLoading(false); }
  };

  const hasData = data && data.cached && data.candles && data.candles.length > 0;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: collapsed ? 0 : 12, flexWrap: 'wrap' }}>
        <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} title="price chart" />
        <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Price Chart</div>
        {!collapsed && <>
          <div style={{ display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
            {TFS.map(b => (
              <button key={b.v} onClick={() => setTf(b.v)} style={{
                background: tf === b.v ? '#27272a' : 'transparent', border: 'none',
                color: tf === b.v ? '#e1e1e6' : '#52525b', padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>{b.label}</button>
            ))}
          </div>
          <button onClick={grab} disabled={loading} style={{
            background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6,
            padding: '6px 14px', cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, opacity: loading ? 0.6 : 1,
          }}>{loading ? 'Fetching…' : hasData ? 'Refresh' : 'Grab data'}</button>
          {hasData && <span style={{ fontSize: 11, color: '#52525b' }}>{data.symbol} · {data.candles.length} bars · ${Number(data.cost).toFixed(6)}</span>}
          {err && <span style={{ fontSize: 12, color: '#f87171' }}>{err}</span>}
        </>}
      </div>
      {!collapsed && (!hasData ? (
        <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3f3f46', fontSize: 13 }}>
          {data && data.cached === false ? 'No data yet — click “Grab data”' : 'Loading…'}
        </div>
      ) : (
        <CandleChart data={{ ...data, candles: aggregate(data.candles, tf) }} levels={levels} />
      ))}
    </div>
  );
}

function CandleChart({ data, levels = [] }) {
  const candles = data.candles;
  const clipId = useId();
  const W = Math.max(680, candles.length * 9 + 70);
  const padL = 60, padR = 12, padT = 12, padB = 24;
  const plotW = W - padL - padR;

  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const m = data.markers || {};
  for (const k of ['entry', 'exit']) if (m[k]) { lo = Math.min(lo, m[k].price); hi = Math.max(hi, m[k].price); }

  // Only pull in levels that sit within a small margin (15% of the candle range) beyond each
  // edge; anything farther is dropped so the range stays tight. The chart HEIGHT then grows a
  // little to fit them, keeping the candlesticks at a readable size instead of squashing them.
  const candleRange = (hi - lo) || 0.0005;
  const LEVEL_MARGIN = 0.15;
  const band = candleRange * LEVEL_MARGIN;
  const loEdge = lo, hiEdge = hi;
  const lvlPrices = [];
  for (const o of levels) {
    if (o.kind === 'zone') lvlPrices.push(o.high, o.low);
    else if (o.kind === 'trend') lvlPrices.push(o.p1, o.p2);
    else if (o.price != null) lvlPrices.push(o.price);
  }
  for (const p of lvlPrices) {
    if (p <= hiEdge + band && p >= loEdge - band) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  }

  const pad = (hi - lo) * 0.08 || 0.0005;
  lo -= pad; hi += pad;

  // Keep the candle band ~a fixed pixel height and grow the plot vertically to fit the range.
  const CANDLE_PX = 210;
  const plotH = Math.max(200, Math.min(900, Math.round((CANDLE_PX / candleRange) * (hi - lo))));
  const H = plotH + padT + padB;

  const x = i => padL + (plotW * (i + 0.5)) / candles.length;
  const y = p => padT + plotH * (1 - (p - lo) / (hi - lo));
  const cw = Math.max(2, (plotW / candles.length) * 0.6);
  const decimals = (hi - lo) < 1 ? 5 : 2;

  // y gridlines
  const ticks = 5;
  const gridY = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);

  // nearest candle index to a timestamp
  const idxAt = ts => {
    let best = 0, bd = Infinity;
    candles.forEach((c, i) => { const d = Math.abs(c.t - ts); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  // map a timestamp to an x position (interpolated across the index-based axis)
  const tMin = candles[0].t, tMax = candles[candles.length - 1].t;
  const xOf = ts => {
    if (ts == null) return padL;
    if (ts <= tMin) return padL;
    if (ts >= tMax) return W - padR;
    let i = 0;
    while (i < candles.length - 1 && candles[i + 1].t <= ts) i++;
    const t0 = candles[i].t, t1 = candles[i + 1].t;
    const f = t1 > t0 ? (ts - t0) / (t1 - t0) : 0;
    return x(i) + (x(i + 1) - x(i)) * f;
  };

  // imported chart levels (S/R lines, rays, zones, trendlines)
  const levelMarks = levels.map((o, i) => {
    const col = o.color || '#a1a1aa';
    if (o.kind === 'zone') {
      const yTop = y(o.high), yBot = y(o.low);
      const xL = o.ts ? xOf(o.ts) : padL;
      // An extended rectangle runs to the right edge; a plain one stops at its end anchor.
      const xR = o.ts2 && !/extend/i.test(o.type || '') ? Math.max(xOf(o.ts2), xL + 1) : W - padR;
      return (
        <g key={i}>
          <rect x={xL} y={Math.min(yTop, yBot)} width={xR - xL} height={Math.max(1, Math.abs(yBot - yTop))}
            fill={col} fillOpacity="0.22" stroke={col} strokeOpacity="0.9" strokeWidth="1" />
          {o.label && <text x={xL + 4} y={Math.min(yTop, yBot) + 10} fill={col} fontSize="9" fontWeight="700">{o.label}</text>}
        </g>
      );
    }
    if (o.kind === 'trend') {
      return (
        <g key={i}>
          <line x1={xOf(o.ts1)} y1={y(o.p1)} x2={xOf(o.ts2)} y2={y(o.p2)} stroke={col} strokeWidth="1.5" />
          <text x={xOf(o.ts2) - 2} y={y(o.p2) - 4} fill={col} fontSize="9" fontWeight="700" textAnchor="end">{o.label}</text>
        </g>
      );
    }
    // line (full width) or ray (from its start time)
    const xL = o.kind === 'ray' ? xOf(o.ts) : padL;
    const yy = y(o.price);
    return (
      <g key={i}>
        <line x1={xL} x2={W - padR} y1={yy} y2={yy} stroke={col} strokeWidth="1" strokeDasharray="5 3" />
        <text x={xL + 4} y={yy - 3} fill={col} fontSize="9" fontWeight="700">{o.label} {o.price}</text>
      </g>
    );
  });

  const marker = (mk, color, label) => {
    if (!mk) return null;
    const cx = x(idxAt(mk.ts));
    const cy = y(mk.price);
    return (
      <g>
        <line x1={padL} x2={W - padR} y1={cy} y2={cy} stroke={color} strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
        <line x1={cx} x2={cx} y1={padT} y2={padT + plotH} stroke={color} strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
        <circle cx={cx} cy={cy} r="4" fill={color} />
        <text x={cx + 6} y={cy - 5} fill={color} fontSize="10" fontWeight="700">{label} {mk.price.toFixed(decimals)}</text>
      </g>
    );
  };

  return (
    <div style={{ overflowX: 'auto', background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: 8 }}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        <defs>
          <clipPath id={clipId}><rect x={padL} y={padT} width={plotW} height={plotH} /></clipPath>
        </defs>
        {gridY.map((p, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke="#1c1c1f" strokeWidth="1" />
            <text x={padL - 6} y={y(p) + 3} fill="#52525b" fontSize="9" textAnchor="end" fontFamily="monospace">{p.toFixed(decimals)}</text>
          </g>
        ))}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? '#22c55e' : '#ef4444';
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyBot = y(Math.min(c.o, c.c));
          return (
            <g key={c.t}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
              <rect x={x(i) - cw / 2} y={bodyTop} width={cw} height={Math.max(1, bodyBot - bodyTop)} fill={col} />
            </g>
          );
        })}
        {levelMarks.length > 0 && <g clipPath={`url(#${clipId})`}>{levelMarks}</g>}
        {marker(m.entry, '#22c55e', 'E')}
        {marker(m.exit, '#f59e0b', 'X')}
        {/* time labels: ~6 across */}
        {Array.from({ length: 6 }, (_, k) => {
          const i = Math.round((candles.length - 1) * k / 5);
          return <text key={k} x={x(i)} y={H - 8} fill="#52525b" fontSize="9" textAnchor="middle">{fmtTime(candles[i].t, data.display_tz)}</text>;
        })}
      </svg>
    </div>
  );
}
