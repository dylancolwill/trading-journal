import React, { useEffect, useState } from 'react';
import { getLevelsForDate, saveLevels, deleteLevels, getLevelsExport, levelsExportUrl } from '../api';

const PLACEHOLDER = `=== NQ 09-26  —  2026-07-18 14:22 ===
(4 objects)

LEVELS (horizontal lines & flat rays)
  15234.50  Weekly S/R  (Labeled Ray, Red, 2026-07-18 09:31)
  ...`;

function fmtDate(str) {
  if (!str) return '';
  const [y, m, d] = str.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

const KIND_COLOR = { line: '#a1a1aa', ray: '#a1a1aa', zone: '#60a5fa', trend: '#facc15' };

// Sentinel instrument for "every instrument saved this day".
const ALL = '*';

const smallBtn = {
  background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6,
  color: '#a1a1aa', padding: '2px 8px', cursor: 'pointer', fontSize: 11,
};

export default function ImportLevelsModal({ date, onClose }) {
  const [rows, setRows] = useState([]);
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState(null);
  const [copied, setCopied] = useState(null);

  const day = String(date || '').slice(0, 10);

  const load = () => getLevelsForDate(date).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [date]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true); setErr(''); setWarn(null);
    try {
      const res = await saveLevels(raw, day);
      // Lines the parser couldn't read are called out — a silently shrinking import is worse
      // than a loud one.
      if (res && res.skipped_count) setWarn(res);
      setRaw('');
      await load();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  // Levels back out in the same format we read, ready to paste into a NinjaTrader importer.
  const copy = async (instrument) => {
    setErr('');
    try {
      await navigator.clipboard.writeText(await getLevelsExport(day, instrument === ALL ? null : instrument, 'txt'));
      setCopied(instrument);
      setTimeout(() => setCopied(c => (c === instrument ? null : c)), 1500);
    } catch (e) { setErr(e.message || 'Copy failed'); }
  };

  const remove = async (id) => {
    await deleteLevels(id);
    load();
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#18181b', border: '1px solid #3f3f46', borderRadius: 12, width: 620, maxWidth: '100%',
        padding: 24, boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700 }}>Import levels · {fmtDate(day)} session</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#71717a', marginBottom: 16 }}>
          Paste your chart snippet. The instrument is read from the header; levels are saved to the{' '}
          <strong style={{ color: '#a1a1aa' }}>{fmtDate(day)} New York session</strong> — the session you traded, not the
          calendar day you exported on. Micro contracts share their parent's levels, so an ES set covers MES trades.
        </div>

        {rows.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Saved for this day</span>
              {rows.length > 1 && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => copy(ALL)} style={{ ...smallBtn, ...(copied === ALL ? { color: '#22c55e', borderColor: '#22c55e' } : {}) }}>
                    {copied === ALL ? 'Copied' : 'Copy all'}
                  </button>
                  <a href={levelsExportUrl(day, null, 'csv')} download style={{ ...smallBtn, textDecoration: 'none' }}>CSV all</a>
                </div>
              )}
            </div>
            {rows.map(r => (
              <div key={r.id} style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{r.instrument} <span style={{ color: '#52525b', fontWeight: 400, fontSize: 12 }}>· {(r.levels || []).length} objects</span></span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => copy(r.instrument)} title="Copy as text (same format this page imports)"
                      style={{ ...smallBtn, ...(copied === r.instrument ? { color: '#22c55e', borderColor: '#22c55e' } : {}) }}>
                      {copied === r.instrument ? 'Copied' : 'Copy'}
                    </button>
                    <a href={levelsExportUrl(day, r.instrument, 'csv')} download title="Download as CSV for a NinjaTrader importer"
                      style={{ ...smallBtn, textDecoration: 'none' }}>CSV</a>
                    <button onClick={() => remove(r.id)} style={{ ...smallBtn, borderColor: '#7f1d1d', color: '#f87171' }}>Delete</button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {(r.levels || []).map((o, i) => (
                    <span key={i} title={o.type} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'monospace',
                      background: '#18181b', border: '1px solid #27272a', borderRadius: 4, padding: '2px 7px', color: '#d4d4d8',
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: o.color || '#71717a', display: 'inline-block' }} />
                      <span style={{ color: KIND_COLOR[o.kind] || '#a1a1aa' }}>{o.kind}</span>
                      {o.kind === 'zone' ? `${o.high}–${o.low}` : o.kind === 'trend' ? `${o.p1}→${o.p2}` : o.price}
                      <span style={{ color: '#52525b' }}>{o.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          style={{
            width: '100%', minHeight: 180, background: '#09090b', border: '1px solid #27272a', borderRadius: 8,
            color: '#e1e1e6', padding: 12, fontSize: 12, fontFamily: 'monospace', resize: 'vertical', lineHeight: 1.5,
          }}
        />
        {err && <div style={{ color: '#f87171', fontSize: 12, marginTop: 8 }}>{err}</div>}
        {warn && (
          <div style={{ background: '#f59e0b12', border: '1px solid #f59e0b55', borderRadius: 6, padding: '8px 10px', marginTop: 8 }}>
            <div style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600 }}>{warn.skipped_count} line{warn.skipped_count !== 1 ? 's' : ''} could not be read and {warn.skipped_count !== 1 ? 'were' : 'was'} not imported</div>
            {(warn.skipped || []).map((l, i) => (
              <div key={i} style={{ color: '#a1a1aa', fontSize: 11, fontFamily: 'monospace', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Close</button>
          <button onClick={save} disabled={saving || !raw.trim()} style={{
            background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6, padding: '8px 18px',
            cursor: saving || !raw.trim() ? 'default' : 'pointer', fontWeight: 700, fontSize: 13, opacity: saving || !raw.trim() ? 0.5 : 1,
          }}>{saving ? 'Saving…' : 'Save levels'}</button>
        </div>
      </div>
    </div>
  );
}
