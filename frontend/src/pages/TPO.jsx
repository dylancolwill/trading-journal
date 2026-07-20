import React, { useEffect, useState } from 'react';
import { getTpo, fetchTpo } from '../api';
import { CollapseToggle } from '../ui';

function fmtTime(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'UTC' });
}

// Bracket letter order — must match the backend's LETTERS sequence.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const VIEW_MODES = [
  { label: 'Compressed', v: 'compressed' }, { label: 'Expanded', v: 'expanded' },
];

export default function TPO({ tradeId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [collapsed, setCollapsed] = useState(true);
  const [viewMode, setViewMode] = useState('compressed');

  useEffect(() => {
    let alive = true;
    getTpo(tradeId).then(d => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [tradeId]);

  const grab = async () => {
    setLoading(true); setErr('');
    try { setData(await fetchTpo(tradeId)); }
    catch (e) { setErr(e.message || 'Fetch failed'); }
    finally { setLoading(false); }
  };

  const hasData = data && data.cached && data.profile && data.profile.rows && data.profile.rows.length > 0;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: collapsed ? 0 : 12, flexWrap: 'wrap' }}>
        <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} title="TPO profile" />
        <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>TPO Profile</div>
        {!collapsed && <>
          <span style={{ fontSize: 11, color: '#52525b' }}>Globex session · 30m brackets</span>
          <div style={{ display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
            {VIEW_MODES.map(m => (
              <button key={m.v} onClick={() => setViewMode(m.v)} style={{
                background: viewMode === m.v ? '#27272a' : 'transparent', border: 'none',
                color: viewMode === m.v ? '#e1e1e6' : '#52525b', padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>{m.label}</button>
            ))}
          </div>
          <button onClick={grab} disabled={loading} style={{
            background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6,
            padding: '6px 14px', cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, opacity: loading ? 0.6 : 1,
          }}>{loading ? 'Fetching…' : hasData ? 'Refresh' : 'Grab data'}</button>
          {hasData && (
            <span style={{ fontSize: 11, color: '#52525b' }}>
              {data.symbol} · {data.profile.bracket_count} brackets · ${Number(data.cost).toFixed(6)}
            </span>
          )}
          {err && <span style={{ fontSize: 12, color: '#f87171' }}>{err}</span>}
        </>}
      </div>
      {!collapsed && (!hasData ? (
        <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3f3f46', fontSize: 13 }}>
          {data && data.cached === false ? 'No data yet — click “Grab data”' : 'Loading…'}
        </div>
      ) : (
        <Profile data={data} viewMode={viewMode} />
      ))}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: '#52525b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || '#e1e1e6', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

function Profile({ data, viewMode = 'compressed' }) {
  const p = data.profile;

  // Expanded ("split") view keeps every 30-min bracket in its own column, so the letters
  // show WHEN each price traded. Compressed pushes them left into the classic bell shape.
  const maxIdx = p.rows.reduce((mx, r) => {
    for (const ch of r.letters) mx = Math.max(mx, LETTERS.indexOf(ch));
    return mx;
  }, -1);
  const lettersFor = (letters) => {
    if (viewMode !== 'expanded') return letters;
    const set = new Set(letters);
    let out = '';
    for (let i = 0; i <= maxIdx; i++) out += set.has(LETTERS[i]) ? LETTERS[i] : ' ';
    return out;
  };
  const dec = p.decimals;
  const half = p.row_size / 2;
  const fmtP = v => Number(v).toFixed(dec);

  const near = (price, level) => level != null && Math.abs(price - level) < half;
  const inVA = price => price <= p.va.high + 1e-9 && price >= p.va.low - 1e-9;
  const inIB = price => p.ib && price <= p.ib.high + 1e-9 && price >= p.ib.low - 1e-9;

  const m = data.markers || {};
  const isShort = m.direction === 'SHORT';
  const entryColor = isShort ? '#ef4444' : '#22c55e';
  const entryLabel = isShort ? 'S' : 'L';

  return (
    <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: 12 }}>
      {/* stats */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #1c1c1f' }}>
        <Stat label="POC" value={fmtP(p.poc)} color="#a78bfa" />
        <Stat label="VAH" value={fmtP(p.va.high)} color="#60a5fa" />
        <Stat label="VAL" value={fmtP(p.va.low)} color="#60a5fa" />
        {p.ib && <Stat label="IB High" value={fmtP(p.ib.high)} color="#f59e0b" />}
        {p.ib && <Stat label="IB Low" value={fmtP(p.ib.low)} color="#f59e0b" />}
        <Stat label="Range" value={`${fmtP(p.session_high)} – ${fmtP(p.session_low)}`} />
        <Stat label="Total TPO" value={p.total_tpo} />
        <Stat label="TPO Count" value={
          <span>
            <span style={{ color: '#22c55e' }}>{p.tpo_over}▲</span>
            <span style={{ color: '#52525b' }}> / </span>
            <span style={{ color: '#ef4444' }}>{p.tpo_under}▼</span>
          </span>
        } />
        <Stat label="Open → Entry" value={`${fmtTime(p.session.open, data.display_tz)}–${fmtTime(p.session.close, data.display_tz)}`} />
      </div>

      {/* profile rows */}
      <div style={{ overflowX: 'auto', fontFamily: 'monospace', fontSize: 12, lineHeight: '15px' }}>
        {p.rows.map((row, i) => {
          const isPoc = near(row.price, p.poc);
          const va = inVA(row.price);
          const ib = inIB(row.price);
          const ibHi = near(row.price, p.ib && p.ib.high);
          const ibLo = near(row.price, p.ib && p.ib.low);
          const isEntry = near(row.price, m.entry && m.entry.price);
          const isExit = near(row.price, m.exit && m.exit.price);

          const bg = isPoc ? 'rgba(167,139,250,0.16)' : va ? 'rgba(96,165,250,0.06)' : 'transparent';
          const priceColor = isPoc ? '#a78bfa' : va ? '#93c5fd' : '#71717a';
          const letterColor = isPoc ? '#c4b5fd' : ib ? '#fbbf24' : va ? '#93c5fd' : '#52525b';

          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', background: bg, whiteSpace: 'nowrap' }}>
              {/* IB bracket rail */}
              <span style={{ width: 4, alignSelf: 'stretch', background: ib ? '#f59e0b' : 'transparent', flexShrink: 0, marginRight: 6 }} />
              {/* price */}
              <span style={{ width: 66, textAlign: 'right', color: priceColor, fontWeight: isPoc ? 700 : 400, flexShrink: 0 }}>
                {fmtP(row.price)}
              </span>
              {/* count */}
              <span style={{ width: 26, textAlign: 'right', color: '#3f3f46', fontSize: 10, flexShrink: 0, marginRight: 8 }}>
                {row.count || ''}
              </span>
              {/* letters */}
              <span style={{ color: letterColor, letterSpacing: 1, flexShrink: 0, whiteSpace: 'pre' }}>{lettersFor(row.letters)}</span>
              {/* level tags */}
              {isPoc && <Tag c="#a78bfa">POC</Tag>}
              {ibHi && <Tag c="#f59e0b">IB H</Tag>}
              {ibLo && <Tag c="#f59e0b">IB L</Tag>}
              {near(row.price, p.va.high) && <Tag c="#60a5fa">VAH</Tag>}
              {near(row.price, p.va.low) && <Tag c="#60a5fa">VAL</Tag>}
              {isEntry && <Tag c={entryColor}>{entryLabel} entry</Tag>}
              {isExit && <Tag c="#f59e0b">exit</Tag>}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: '#52525b', marginTop: 10 }}>
        built from Globex open up to trade entry · each letter = one 30-min bracket · POC = most-traded level · value area = 70% of TPOs · IB = London first hour · TPO count = TPOs above ▲ / below ▼ POC
      </div>
    </div>
  );
}

function Tag({ c, children }) {
  return (
    <span style={{
      marginLeft: 8, fontSize: 9, fontWeight: 800, color: c, background: c + '1f',
      border: `1px solid ${c}55`, borderRadius: 3, padding: '0 5px', lineHeight: '13px', flexShrink: 0,
    }}>{children}</span>
  );
}
