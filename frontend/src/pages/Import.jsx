import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { importCsv, previewCsv, fetchCandles, fetchFootprint, fetchTpo } from '../api';

const s = {
  page: { padding: 24, maxWidth: 800, margin: '0 auto' },
  card: { background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 32, marginBottom: 20 },
  drop: { border: '2px dashed #3f3f46', borderRadius: 10, padding: 48, textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.2s' },
  btn: { background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6, padding: '9px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btnOutline: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, padding: '9px 20px', cursor: 'pointer', color: '#a1a1aa', fontSize: 14 },
  previewRow: { display: 'grid', gridTemplateColumns: '160px 100px 60px 60px 80px 80px 70px 80px', gap: 8, padding: '8px 0', borderBottom: '1px solid #27272a', fontSize: 12 },
  th: { color: '#71717a', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  success: { background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: 16, color: '#22c55e', marginTop: 16, fontSize: 14 },
  error: { background: '#1c0a09', border: '1px solid #7f1d1d', borderRadius: 8, padding: 16, color: '#f87171', marginTop: 16, fontSize: 14 },
};

export default function Import() {
  const [file, setFile] = useState(null);
  const [dateFormat] = useState('au'); // AU default; backend auto-detects unambiguous dates
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [gen, setGen] = useState(null); // { running, done, total, skipped }
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const navigate = useNavigate();

  const handleFile = async (f) => {
    if (!f || !f.name.endsWith('.csv')) return setError('Please select a CSV file');
    setFile(f);
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const p = await previewCsv(f, dateFormat);
      setPreview(p);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const r = await importCsv(file, dateFormat);
      setResult(r);
      setPreview(null);
      setFile(null);
      await autoGenerate(r.ids || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // After import, pre-fetch candlestick + footprint + TPO data for each new trade so the
  // charts are ready without clicking "Grab data". Failures (e.g. Databento's ~1-day lag on
  // very recent trades) are skipped so the whole batch still completes.
  const autoGenerate = async (ids) => {
    if (!ids.length) return;
    setGen({ running: true, done: 0, total: ids.length, skipped: 0 });
    let done = 0, skipped = 0;
    for (const id of ids) {
      let anyOk = false;
      for (const fn of [fetchCandles, fetchFootprint, fetchTpo]) {
        try { await fn(id); anyOk = true; } catch { /* keep going */ }
      }
      done++; if (!anyOk) skipped++;
      setGen({ running: true, done, total: ids.length, skipped });
    }
    setGen({ running: false, done, total: ids.length, skipped });
  };

  return (
    <div style={s.page}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24 }}>Import NinjaTrader CSV</h2>

      <div style={s.card}>
        <div
          style={{ ...s.drop, borderColor: dragging ? '#a78bfa' : '#3f3f46' }}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
          <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
          <div style={{ color: '#a1a1aa', fontSize: 14 }}>{file ? file.name : 'Drop CSV here or click to browse'}</div>
          {file && <div style={{ color: '#52525b', fontSize: 12, marginTop: 4 }}>{(file.size / 1024).toFixed(1)} KB</div>}
        </div>

        {error && <div style={s.error}>{error}</div>}
        {result && (
          <div style={s.success}>
            ✓ Imported {result.imported} trade{result.imported !== 1 ? 's' : ''} successfully.{' '}
            <a href="/trades" style={{ color: '#22c55e', fontWeight: 600 }} onClick={e => { e.preventDefault(); navigate('/trades'); }}>View trades →</a>
            {gen && (
              <div style={{ marginTop: 10, fontSize: 13, color: gen.running ? '#a1a1aa' : '#22c55e' }}>
                {gen.running
                  ? `Generating chart data… ${gen.done}/${gen.total}`
                  : `✓ Chart data ready for ${gen.total - gen.skipped}/${gen.total} trade${gen.total !== 1 ? 's' : ''}${gen.skipped ? ` (${gen.skipped} skipped — data not available yet)` : ''}`}
              </div>
            )}
          </div>
        )}
      </div>

      {preview && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>{preview.count} trade{preview.count !== 1 ? 's' : ''} found</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={s.btnOutline} onClick={() => { setFile(null); setPreview(null); }}>Cancel</button>
              <button style={s.btn} onClick={handleImport} disabled={loading}>{loading ? 'Importing…' : 'Import All'}</button>
            </div>
          </div>
          <div style={{ ...s.previewRow, ...s.th, paddingBottom: 8 }}>
            <span>Date / Time</span><span>Instrument</span><span>Dir</span><span>Qty</span><span>Entry</span><span>Exit</span><span>Fees</span><span>Net P&L</span>
          </div>
          {preview.trades.map((t, i) => {
            const timeStr = t.entry_time
              ? new Date(t.entry_time).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true })
              : '';
            return (
              <div key={i} style={s.previewRow}>
                <span style={{ color: '#a1a1aa' }}>
                  {t.trade_date}
                  {timeStr && <span style={{ color: '#52525b', marginLeft: 6 }}>{timeStr}</span>}
                </span>
                <span style={{ fontWeight: 600 }}>{t.instrument}</span>
                <span style={{ color: t.direction === 'LONG' ? '#22c55e' : '#ef4444' }}>{t.direction}</span>
                <span>{t.quantity}</span>
                <span>{parseFloat(t.entry_price).toFixed(5)}</span>
                <span>{t.exit_price ? parseFloat(t.exit_price).toFixed(5) : <span style={{ color: '#52525b' }}>open</span>}</span>
                <span style={{ color: '#71717a' }}>${parseFloat(t.commission || 0).toFixed(2)}</span>
                <span style={{ color: parseFloat(t.net_pnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                  {t.open ? <span style={{ color: '#f59e0b' }}>open</span> : `$${parseFloat(t.net_pnl || 0).toFixed(2)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
