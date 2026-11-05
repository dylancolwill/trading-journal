import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTrade, patchTrade, addTag, removeTag, getTags, uploadImage, deleteImage } from '../api';
import Footprint from './Footprint';
import Candles from './Candles';
import TPO from './TPO';
import ReactMarkdown from 'react-markdown';
import { mdComponents, gradeColor } from '../markdown';

const s = {
  page: { padding: 24, maxWidth: 960, margin: '0 auto' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  card: { background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 24, marginBottom: 20 },
  label: { fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  value: { fontSize: 15, fontWeight: 600 },
  row: { marginBottom: 16 },
  tag: { display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', margin: '2px', border: '1px solid transparent' },
  textarea: { width: '100%', background: '#09090b', border: '1px solid #27272a', borderRadius: 8, color: '#e1e1e6', padding: 12, fontSize: 13, resize: 'vertical', minHeight: 100, fontFamily: 'inherit' },
  btn: { background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  btnSm: { background: '#27272a', color: '#a1a1aa', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  fillRow: { display: 'grid', gridTemplateColumns: '100px 55px 50px 90px 70px', gap: 8, padding: '7px 0', borderBottom: '1px solid #27272a', fontSize: 12 },
  th: { color: '#71717a', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  imgGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 12 },
  imgWrap: { position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #27272a' },
};

function gradeLabel(g) {
  if (!g) return '–';
  return g.charAt(0).toUpperCase() + g.slice(1);
}

function scoreColor(s) {
  if (s == null) return '#52525b';
  if (s >= 8) return '#22c55e';
  if (s >= 6) return '#f59e0b';
  if (s >= 4) return '#f97316';
  return '#ef4444';
}

function pnlColor(val) {
  if (val == null) return '#a1a1aa';
  return parseFloat(val) >= 0 ? '#22c55e' : '#ef4444';
}

export default function TradeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [trade, setTrade] = useState(null);
  const [allTags, setAllTags] = useState([]);
  const [desc, setDesc] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiScore, setAiScore] = useState(null);
  const [aiGrades, setAiGrades] = useState(null); // { entryGrade, entryNote, exitGrade, exitNote, directionGrade, directionNote }
  const [aiStatus, setAiStatus] = useState(''); // '' | 'generating' | 'saved'
  const [aiStage, setAiStage] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const elapsedTimer = useRef(null);
  const [aiError, setAiError] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const fileRef = useRef();
  const tagDropRef = useRef();
  const debounceRef = useRef(null);
  const initialDescLoad = useRef(true);

  const load = () => Promise.all([getTrade(id), getTags()]).then(([t, tags]) => {
    initialDescLoad.current = true;
    setTrade(t);
    setDesc(t.description || '');
    setAiAnalysis(t.ai_analysis || '');
    setAiScore(t.ai_score != null ? parseFloat(t.ai_score) : null);
    setAiGrades(t.ai_entry_grade ? {
      entryGrade: t.ai_entry_grade, entryNote: t.ai_entry_note,
      exitGrade: t.ai_exit_grade, exitNote: t.ai_exit_note,
      directionGrade: t.ai_direction_correct, directionNote: t.ai_direction_note,
    } : null);
    setAllTags(tags);
  });

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (initialDescLoad.current) { initialDescLoad.current = false; return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      await patchTrade(trade.id, { description: desc });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(''), 2000);
    }, 2500); // idle delay before autosaving notes
    return () => clearTimeout(debounceRef.current);
  }, [desc]);


  useEffect(() => {
    const handler = (e) => { if (tagDropRef.current && !tagDropRef.current.contains(e.target)) setTagOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => clearInterval(elapsedTimer.current), []);

  if (!trade) return <div style={{ padding: 24, color: '#52525b' }}>Loading…</div>;

  const tradeTags = new Set((trade.tags || []).map(t => t.id));

  const handleTagToggle = async (tagId) => {
    if (tradeTags.has(tagId)) await removeTag(trade.id, tagId);
    else await addTag(trade.id, tagId);
    load();
  };

  const STAGES = [
    [/^\s*(?:##\s*|\*\*)?7[.)]/im, 'Scoring trade…'],
    [/^\s*(?:##\s*|\*\*)?6[.)]/im, 'Extracting key lesson…'],
    [/^\s*(?:##\s*|\*\*)?5[.)]/im, 'What went right…'],
    [/^\s*(?:##\s*|\*\*)?4[.)]/im, 'Risk & management…'],
    [/^\s*(?:##\s*|\*\*)?3[.)]/im, 'Direction…'],
    [/^\s*(?:##\s*|\*\*)?2[.)]/im, 'Assessing location…'],
    [/^\s*(?:##\s*|\*\*)?1[.)]/im, 'Reading auction context…'],
  ];

  const handleGenerateAi = async () => {
    setAiStatus('generating');
    setAiStage('Building context (orderflow, TPO, levels)…');
    setAiError('');
    setAiAnalysis('');
    setAiElapsed(0);
    const startedAt = Date.now();
    clearInterval(elapsedTimer.current);
    elapsedTimer.current = setInterval(() => setAiElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    try {
      const response = await fetch(`/api/trades/${trade.id}/analyze`, { method: 'POST' });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${response.status}: ${response.statusText}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (data.stage) setAiStage(data.stage);
          if (typeof data.elapsed === 'number') setAiElapsed(data.elapsed);
          if (data.text) {
            accumulated += data.text;
            setAiAnalysis(prev => prev + data.text);
            let matched = false;
            for (const [pattern, label] of STAGES) {
              if (pattern.test(accumulated)) { setAiStage(label); matched = true; break; }
            }
            if (!matched) setAiStage('Analysing trade…');
          } else if (data.done) {
            if (data.score != null) setAiScore(data.score);
            if (data.entryGrade) setAiGrades({
              entryGrade: data.entryGrade, entryNote: data.entryNote,
              exitGrade: data.exitGrade, exitNote: data.exitNote,
              directionGrade: data.directionGrade, directionNote: data.directionNote,
            });
            setAiStage('');
            setAiStatus('saved');
            setTimeout(() => setAiStatus(''), 2000);
          } else if (data.error) {
            throw new Error(data.error || 'Claude returned an error during generation');
          }
        }
      }
    } catch (e) {
      setAiStatus('');
      setAiStage('');
      setAiError(e.message || 'Unknown error — check server logs');
    } finally {
      clearInterval(elapsedTimer.current);
    }
  };

  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    await Promise.all(files.map(f => uploadImage(trade.id, f)));
    load();
    fileRef.current.value = '';
  };

  const handleDeleteImage = async (imgId) => {
    if (!confirm('Delete image?')) return;
    await deleteImage(imgId);
    load();
  };

  const fmtDate = (str) => { if (!str) return '–'; const [y, m, d] = str.slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
  const fmtPrice = (v) => v != null ? parseFloat(v).toString() : '–';
  const fmtMoney = (v, dec = 2) => v != null ? parseFloat(v).toFixed(dec) : '–';
  const fmtFillTime = (str) => {
    if (!str) return '–';
    const timePart = (str.includes('T') ? str.split('T')[1] : str.split(' ')[1]) || '';
    const [h, m, s = '00'] = timePart.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m}:${s.slice(0, 2)} ${hour >= 12 ? 'PM' : 'AM'}`;
  };

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button style={s.btnSm} onClick={() => navigate('/trades')}>← Back</button>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>
          {trade.instrument}
          <span style={{ color: trade.direction === 'LONG' ? '#22c55e' : '#ef4444', marginLeft: 10, fontSize: 14 }}>{trade.direction}</span>
          {trade.open && <span style={{ color: '#f59e0b', fontSize: 12, marginLeft: 8, fontWeight: 600 }}>OPEN</span>}
        </h2>
      </div>

      <div style={s.grid}>
        <div>
          <div style={s.card}>
            {[
              ['Date', trade.entry_time ? `${fmtDate(trade.trade_date)}  ${fmtFillTime(trade.entry_time)}` : fmtDate(trade.trade_date)],
              ['Account', trade.account],
              ['Quantity', trade.quantity],
              ['Entry Price', fmtPrice(trade.entry_price)],
              ['Exit Price', fmtPrice(trade.exit_price)],
              ['Gross P&L', { value: `$${fmtMoney(trade.gross_pnl)}`, color: pnlColor(trade.gross_pnl) }],
              ['Commission', `$${fmtMoney(trade.commission)}`],
              ['Net P&L', { value: `$${fmtMoney(trade.net_pnl)}`, color: pnlColor(trade.net_pnl) }],
            ].map(([label, val]) => (
              <div key={label} style={s.row}>
                <div style={s.label}>{label}</div>
                <div style={{ ...s.value, ...(val && val.color ? { color: val.color } : {}) }}>
                  {val && val.value ? val.value : val}
                </div>
              </div>
            ))}
          </div>

          <div style={s.card}>
            <div style={s.label}>Fills</div>
            <div style={{ ...s.fillRow, ...s.th, paddingTop: 8 }}>
              <span>Time</span><span>Action</span><span>Qty</span><span>Price</span><span>Comm</span>
            </div>
            {(trade.fills || []).map(f => (
              <div key={f.id} style={s.fillRow}>
                <span style={{ color: '#71717a' }}>{fmtFillTime(f.fill_time)}</span>
                <span style={{ color: f.action === 'Buy' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{f.action}</span>
                <span>{f.quantity}</span>
                <span>{fmtPrice(f.price)}</span>
                <span style={{ color: '#71717a' }}>${parseFloat(f.commission || 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={s.label}>Tags</div>
              <div ref={tagDropRef} style={{ position: 'relative' }}>
                <button style={s.btnSm} onClick={() => setTagOpen(o => !o)}>+ Add tag</button>
                {tagOpen && (
                  <div style={{
                    position: 'absolute', right: 0, top: '110%', zIndex: 100,
                    background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10,
                    padding: '12px 14px', minWidth: 220, maxHeight: 360, overflowY: 'auto',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                  }}>
                    {(() => {
                      const groups = {};
                      for (const tag of allTags) {
                        const g = tag.group_name || '';
                        if (!groups[g]) groups[g] = [];
                        groups[g].push(tag);
                      }
                      const named = Object.keys(groups).filter(g => g !== '').sort();
                      const entries = named.map(g => [g, groups[g]]);
                      if (groups['']) entries.push(['', groups['']]);
                      return entries.map(([groupName, groupTags]) => (
                        <div key={groupName || '__other'} style={{ marginBottom: 8 }}>
                          {groupName && (
                            <div style={{ fontSize: 10, color: '#52525b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4, paddingTop: 4 }}>
                              {groupName}
                            </div>
                          )}
                          <div>
                            {groupTags.map(tag => {
                              const active = tradeTags.has(tag.id);
                              return (
                                <span key={tag.id} style={{
                                  ...s.tag,
                                  background: active ? tag.color + '30' : 'transparent',
                                  color: active ? tag.color : '#52525b',
                                  borderColor: active ? tag.color + '60' : '#27272a',
                                  opacity: active ? 1 : 0.7,
                                }} onClick={() => handleTagToggle(tag.id)}>
                                  {active && <span style={{ fontSize: 10, marginRight: 2 }}>✓</span>}
                                  {tag.name}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 28 }}>
              {(trade.tags || []).length === 0
                ? <span style={{ color: '#3f3f46', fontSize: 12 }}>No tags</span>
                : (trade.tags || []).map(tag => (
                  <span key={tag.id} style={{
                    ...s.tag,
                    background: tag.color + '30',
                    color: tag.color,
                    borderColor: tag.color + '60',
                    gap: 6,
                  }}>
                    {tag.name}
                    <span style={{ opacity: 0.6, fontSize: 10, cursor: 'pointer', lineHeight: 1 }}
                      onClick={() => handleTagToggle(tag.id)}>✕</span>
                  </span>
                ))
              }
            </div>
          </div>

          <div style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={s.label}>Notes</div>
              <span style={{ fontSize: 11, color: saveStatus === 'saved' ? '#22c55e' : '#52525b', transition: 'color 0.2s' }}>
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
              </span>
            </div>
            <textarea
              style={s.textarea}
              value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="Trade notes, setup, lessons learned…"
            />
          </div>

          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={s.label}>Images</div>
              <button style={s.btnSm} onClick={() => fileRef.current.click()}>+ Add Image</button>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleImageUpload} />
            </div>
            {trade.images && trade.images.length > 0 ? (
              <div style={s.imgGrid}>
                {trade.images.map(img => (
                  <div key={img.id} style={s.imgWrap}>
                    <img
                      src={`/api/images/file/${img.filename}`}
                      alt={img.original_name}
                      style={{ width: '100%', display: 'block', cursor: 'pointer' }}
                      onClick={() => setLightbox(`/api/images/file/${img.filename}`)}
                    />
                    <button
                      onClick={() => handleDeleteImage(img.id)}
                      style={{ position: 'absolute', top: 4, right: 4, background: '#18181b', border: 'none', color: '#f87171', cursor: 'pointer', borderRadius: 4, padding: '2px 6px', fontSize: 11 }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#52525b', fontSize: 13 }}>No images yet</div>
            )}
          </div>
        </div>
      </div>

      <div style={{ ...s.card, marginTop: 0 }}>
        <Candles tradeId={trade.id} />
        <Footprint tradeId={trade.id} />
        <TPO tradeId={trade.id} />
      </div>

      <div style={{ ...s.card, marginTop: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={s.label}>AI Analysis</div>
            {aiScore != null && (
              <div style={{
                fontSize: 18, fontWeight: 800, color: scoreColor(aiScore),
                background: scoreColor(aiScore) + '18', borderRadius: 8,
                padding: '2px 10px', lineHeight: 1.4, letterSpacing: -0.5,
              }}>
                {aiScore}<span style={{ fontSize: 11, fontWeight: 500, color: '#52525b' }}>/10</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: aiStatus === 'saved' ? '#22c55e' : aiStatus === 'generating' ? '#f59e0b' : '#52525b' }}>
              {aiStatus === 'generating'
                ? <>{aiStage}{aiElapsed > 0 && <span style={{ color: '#71717a', fontFamily: 'monospace' }}> · {aiElapsed}s</span>}</>
                : aiStatus === 'saved' ? 'Saved' : ''}
            </span>
            <button
              style={{ ...s.btnSm, opacity: aiStatus === 'generating' || !trade.has_ticks ? 0.4 : 1 }}
              onClick={handleGenerateAi}
              disabled={aiStatus === 'generating' || !trade.has_ticks}
              title={!trade.has_ticks ? 'Grab footprint data first' : ''}>
              {aiStatus === 'generating' ? 'Generating…' : aiAnalysis ? '↺ Regenerate' : '✦ Generate'}
            </button>
          </div>
        </div>

        {aiGrades && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Entry', grade: aiGrades.entryGrade, note: aiGrades.entryNote },
              { label: 'Exit',  grade: aiGrades.exitGrade,  note: aiGrades.exitNote  },
              { label: 'Direction', grade: aiGrades.directionGrade, note: aiGrades.directionNote },
            ].map(({ label, grade, note }) => (
              <div key={label} style={{ background: '#09090b', border: `1px solid ${gradeColor(grade)}44`, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 10, color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: gradeColor(grade), background: gradeColor(grade) + '18', borderRadius: 4, padding: '1px 6px' }}>{gradeLabel(grade)}</span>
                </div>
                <p style={{ fontSize: 12, color: '#a1a1aa', margin: 0, lineHeight: 1.5 }}>{note || '–'}</p>
              </div>
            ))}
          </div>
        )}

        {aiError && (
          <div style={{ background: '#2a0f0f', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#fca5a5' }}>
            <strong style={{ color: '#f87171' }}>Analysis failed:</strong> {aiError}
          </div>
        )}

        {aiAnalysis ? (
          <div style={{ color: '#e1e1e6', fontSize: 13, lineHeight: 1.7 }}>
            <ReactMarkdown components={mdComponents}>
              {aiAnalysis}
            </ReactMarkdown>
            {aiStatus === 'generating' && <span style={{ display: 'inline-block', width: 8, height: 14, background: '#a78bfa', borderRadius: 2, animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom', marginLeft: 2 }} />}
          </div>
        ) : (
          <div style={{ color: '#3f3f46', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
            {aiStatus === 'generating'
              ? <span style={{ color: '#71717a' }}>
                  {aiStage || 'Generating…'}
                  {aiElapsed > 0 && <span style={{ fontFamily: 'monospace', color: '#52525b' }}> · {aiElapsed}s</span>}
                </span>
              : trade.has_ticks
                ? 'Click Generate to analyse this trade using orderflow data'
                : 'Grab footprint data first to enable AI analysis'}
          </div>
        )}
        <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out',
          }}>
          <button
            onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
            style={{ position: 'absolute', top: 16, right: 20, background: '#18181b', border: '1px solid #3f3f46', color: '#e1e1e6', borderRadius: 8, width: 36, height: 36, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>
            ✕
          </button>
          <img
            src={lightbox}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 8, cursor: 'default', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}
          />
        </div>
      )}
    </div>
  );
}
