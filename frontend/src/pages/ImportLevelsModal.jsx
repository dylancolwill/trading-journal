import React, { useEffect, useState } from 'react';
import { getLevelsForDate, saveLevels, deleteLevels } from '../api';

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

export default function ImportLevelsModal({ date, onClose }) {
  const [rows, setRows] = useState([]);
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const load = () => getLevelsForDate(date).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [date]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      await saveLevels(raw, date);
      setRaw('');
      await load();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
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
          <h3 style={{ fontSize: 17, fontWeight: 700 }}>Import levels</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#71717a', marginBottom: 16 }}>{fmtDate(date)} — paste your chart snippet. The instrument is read from the header; levels are saved to <strong style={{ color: '#a1a1aa' }}>this day</strong>.</div>

        {rows.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Saved for this day</div>
            {rows.map(r => (
              <div key={r.id} style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{r.instrument} <span style={{ color: '#52525b', fontWeight: 400, fontSize: 12 }}>· {(r.levels || []).length} objects</span></span>
                  <button onClick={() => remove(r.id)} style={{ background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 6, color: '#f87171', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>Delete</button>
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
