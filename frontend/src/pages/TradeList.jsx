import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTrades, deleteTrade, getTags, getLevelDates, fetchCandles, fetchTpo, fetchFootprint } from '../api';
import ImportLevelsModal from './ImportLevelsModal';

const s = {
  page: { padding: 24, maxWidth: 1200, margin: '0 auto' },
  topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  filterToggle: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '6px 14px', cursor: 'pointer', fontSize: 13 },
  filterPanel: { background: '#18181b', border: '1px solid #27272a', borderRadius: 10, padding: '18px 20px', marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { background: '#09090b', border: '1px solid #27272a', borderRadius: 6, padding: '6px 10px', color: '#e1e1e6', fontSize: 13, minWidth: 130 },
  select: { background: '#09090b', border: '1px solid #27272a', borderRadius: 6, padding: '6px 10px', color: '#e1e1e6', fontSize: 13, minWidth: 130, cursor: 'pointer' },
  btn: { background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  btnGhost: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#71717a', padding: '7px 14px', cursor: 'pointer', fontSize: 13 },
  summary: { display: 'flex', gap: 20, marginBottom: 12, fontSize: 13, color: '#71717a', alignItems: 'center' },
  viewToggle: { display: 'flex', gap: 0, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' },
  viewBtn: (active) => ({ background: active ? '#27272a' : 'transparent', border: 'none', color: active ? '#e1e1e6' : '#52525b', padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }),
  table: { background: '#18181b', borderRadius: 10, border: '1px solid #27272a', overflow: 'hidden', width: '100%' },
  th: { padding: '9px 12px', color: '#71717a', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left', borderBottom: '1px solid #27272a', background: '#18181b', whiteSpace: 'nowrap' },
  td: { padding: '9px 12px', fontSize: 13, borderBottom: '1px solid #1c1c1e', whiteSpace: 'nowrap' },
  btnDanger: { background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 6, color: '#f87171', padding: '3px 8px', cursor: 'pointer', fontSize: 11 },
  dayHeader: { background: '#1c1c1e', padding: '10px 16px', display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 16, alignItems: 'center', borderBottom: '1px solid #27272a', cursor: 'pointer' },
  dayTrade: { display: 'grid', gridTemplateColumns: '80px 110px 55px 45px 90px 90px 90px 90px 55px 1fr', gap: 10, padding: '9px 16px', borderBottom: '1px solid #1c1c1e', fontSize: 13, cursor: 'pointer', alignItems: 'center' },
  importBtn: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
};

function pnlColor(v) { return v == null ? '#a1a1aa' : parseFloat(v) >= 0 ? '#22c55e' : '#ef4444'; }

function scoreColor(s) {
  if (s == null) return '#52525b';
  if (s >= 8) return '#22c55e';
  if (s >= 6) return '#f59e0b';
  if (s >= 4) return '#f97316';
  return '#ef4444';
}

function ScoreBadge({ score }) {
  if (score == null) return null;
  const s = parseFloat(score);
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(s), background: scoreColor(s) + '18', borderRadius: 4, padding: '1px 5px' }}>
      {s}<span style={{ fontWeight: 400, color: '#52525b', fontSize: 10 }}>/10</span>
    </span>
  );
}

function fmtDate(str) {
  if (!str) return '';
  const [y, m, d] = str.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

function fmtTime(str) {
  if (!str) return '';
  const timePart = str.includes('T') ? str.split('T')[1] : str.split(' ')[1] || '';
  if (!timePart) return '';
  const [hStr, mStr] = timePart.split(':');
  const h = parseInt(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${mStr} ${ampm}`;
}

function fmtPnl(v) {
  if (v == null) return '–';
  const n = parseFloat(v);
  return `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;
}

export default function TradeList() {
  const [trades, setTrades] = useState([]);
  const [filters, setFilters] = useState({ from: '', to: '', account: '', instrument: '', direction: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState('daily'); // 'table' | 'daily'
  const [accounts, setAccounts] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [collapsedDays, setCollapsedDays] = useState({});
  const [levelsDate, setLevelsDate] = useState(null);
  const [genState, setGenState] = useState({});
  const [levelDates, setLevelDates] = useState(new Set());
  const navigate = useNavigate();

  const loadLevelDates = useCallback(() => {
    getLevelDates().then(rows => setLevelDates(new Set(rows.map(r => r.trade_date.slice(0, 10))))).catch(() => {});
  }, []);
  useEffect(() => { loadLevelDates(); }, [loadLevelDates]);

  const load = useCallback(() => {
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    getTrades(params).then(setTrades).catch(console.error);
  }, [filters]);

  useEffect(() => { load(); }, []);

  useEffect(() => {
    fetch('/api/trades/meta/accounts').then(r => r.json()).then(setAccounts).catch(() => {});
    fetch('/api/trades/meta/instruments').then(r => r.json()).then(setInstruments).catch(() => {});
  }, [trades]);

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const closed = trades.filter(t => !t.open);
  const totalPnl = closed.reduce((s, t) => s + parseFloat(t.net_pnl || 0), 0);
  const wins = closed.filter(t => parseFloat(t.net_pnl || 0) > 0).length;
  const winTrades = closed.filter(t => parseFloat(t.net_pnl || 0) > 0);
  const lossTrades = closed.filter(t => parseFloat(t.net_pnl || 0) < 0);
  const avgWin = winTrades.length ? winTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / winTrades.length : null;
  const avgLoss = lossTrades.length ? lossTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / lossTrades.length : null;
  const grossWins = winTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0);
  const grossLosses = Math.abs(lossTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : null);

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this trade?')) return;
    await deleteTrade(id);
    load();
  };

  const applyFilters = () => load();
  const clearFilters = () => {
    const empty = { from: '', to: '', account: '', instrument: '', direction: '' };
    setFilters(empty);
    const params = {};
    getTrades(params).then(setTrades).catch(console.error);
  };

  // Group trades by date for daily view
  const byDate = {};
  for (const t of trades) {
    const d = t.trade_date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  }
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  const toggleDay = (d) => setCollapsedDays(prev => ({ ...prev, [d]: !prev[d] }));

  const handleImportLevels = (e, date) => {
    e.stopPropagation();
    setLevelsDate(date);
  };

  // Pull candles, TPO and footprint for every trade on a day in one go. Each endpoint
  // only buys the sub-intervals it is missing, so re-running a finished day costs $0.
  const handleGenerate = async (e, date) => {
    e.stopPropagation();
    const dayTrades = byDate[date] || [];
    if (!dayTrades.length || genState[date]?.running) return;
    const total = dayTrades.length * 3;
    let done = 0, cost = 0;
    const failed = [];
    setGenState(prev => ({ ...prev, [date]: { running: true, done, total, cost } }));
    for (const t of dayTrades) {
      for (const [name, fn] of [['candles', fetchCandles], ['tpo', fetchTpo], ['footprint', fetchFootprint]]) {
        try {
          const r = await fn(t.id);
          cost += Number(r?.cost) || 0;
        } catch (err) {
          failed.push(`#${t.id} ${name}`);
        }
        done++;
        setGenState(prev => ({ ...prev, [date]: { running: true, done, total, cost } }));
      }
    }
    setGenState(prev => ({ ...prev, [date]: { running: false, done, total, cost, failed } }));
  };

  const tradeRow = (t) => (
    <tr key={t.id}
      style={{ cursor: 'pointer' }}
      onClick={() => navigate(`/trades/${t.id}`)}
      onMouseEnter={e => e.currentTarget.style.background = '#1c1c1e'}
      onMouseLeave={e => e.currentTarget.style.background = ''}>
      <td style={s.td}>{fmtDate(t.trade_date)}</td>
      <td style={{ ...s.td, color: '#71717a' }}>{fmtTime(t.entry_time)}</td>
      <td style={{ ...s.td, fontWeight: 600 }}>{t.instrument}</td>
      <td style={{ ...s.td, color: t.direction === 'LONG' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{t.direction}</td>
      <td style={s.td}>{t.quantity}</td>
      <td style={s.td}>{parseFloat(t.entry_price).toString()}</td>
      <td style={s.td}>{t.exit_price ? parseFloat(t.exit_price).toString() : <span style={{ color: '#52525b' }}>open</span>}</td>
      <td style={{ ...s.td, color: pnlColor(t.gross_pnl) }}>{t.gross_pnl != null ? fmtPnl(t.gross_pnl) : '–'}</td>
      <td style={{ ...s.td, color: pnlColor(t.net_pnl), fontWeight: 600 }}>
        {t.open ? <span style={{ color: '#f59e0b', fontSize: 11 }}>OPEN</span> : t.net_pnl != null ? fmtPnl(t.net_pnl) : '–'}
      </td>
      <td style={s.td}><ScoreBadge score={t.ai_score} /></td>
      <td style={{ ...s.td, color: '#71717a' }}>{t.account}</td>
      <td style={s.td}>
        {(t.tags || []).map(tg => (
          <span key={tg.id} style={{ background: tg.color + '22', color: tg.color, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600, marginRight: 3 }}>{tg.name}</span>
        ))}
      </td>
      <td style={s.td}>
        <button style={s.btnDanger} onClick={e => handleDelete(e, t.id)}>del</button>
      </td>
    </tr>
  );

  const tableHeaders = ['Date', 'Time', 'Instrument', 'Dir', 'Qty', 'Entry', 'Exit', 'Gross P&L', 'Net P&L', 'Score', 'Account', 'Tags', ''];

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Trades</h2>
        <button style={s.filterToggle} onClick={() => setShowFilters(v => !v)}>
          {showFilters ? 'Hide Filters ▲' : 'Filters ▼'}
        </button>
      </div>

      {showFilters && (
        <div style={s.filterPanel}>
          <div style={s.field}>
            <span style={s.label}>From</span>
            <input style={s.input} type="date" value={filters.from} onChange={e => setF('from', e.target.value)} />
          </div>
          <div style={s.field}>
            <span style={s.label}>To</span>
            <input style={s.input} type="date" value={filters.to} onChange={e => setF('to', e.target.value)} />
          </div>
          <div style={s.field}>
            <span style={s.label}>Account</span>
            <select style={s.select} value={filters.account} onChange={e => setF('account', e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div style={s.field}>
            <span style={s.label}>Instrument</span>
            <select style={s.select} value={filters.instrument} onChange={e => setF('instrument', e.target.value)}>
              <option value="">All instruments</option>
              {instruments.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div style={s.field}>
            <span style={s.label}>Direction</span>
            <select style={s.select} value={filters.direction} onChange={e => setF('direction', e.target.value)}>
              <option value="">Both</option>
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end' }}>
            <button style={s.btn} onClick={applyFilters}>Apply</button>
            <button style={s.btnGhost} onClick={clearFilters}>Clear</button>
          </div>
        </div>
      )}

      <div style={s.summary}>
        <span>{trades.length} trades</span>
        {closed.length > 0 && <>
          <span style={{ color: pnlColor(totalPnl) }}>Net P&L: {fmtPnl(totalPnl)}</span>
          <span>Win rate: {closed.length ? ((wins / closed.length) * 100).toFixed(0) : 0}%</span>
          {avgWin != null && <span style={{ color: '#22c55e' }}>Avg W: {fmtPnl(avgWin)}</span>}
          {avgLoss != null && <span style={{ color: '#ef4444' }}>Avg L: {fmtPnl(avgLoss)}</span>}
          {profitFactor != null && <span>PF: {profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</span>}
        </>}
        <div style={{ marginLeft: 'auto' }}>
          <div style={s.viewToggle}>
            <button style={s.viewBtn(viewMode === 'daily')} onClick={() => setViewMode('daily')}>Daily</button>
            <button style={s.viewBtn(viewMode === 'table')} onClick={() => setViewMode('table')}>Table</button>
          </div>
        </div>
      </div>

      {viewMode === 'table' && (
        <div style={s.table}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{tableHeaders.map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {trades.map(tradeRow)}
              {trades.length === 0 && (
                <tr><td colSpan={tableHeaders.length} style={{ ...s.td, color: '#52525b', textAlign: 'center', padding: 32 }}>No trades found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {viewMode === 'daily' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortedDates.length === 0 && (
            <div style={{ color: '#52525b', fontSize: 13, padding: 24, textAlign: 'center' }}>No trades found</div>
          )}
          {sortedDates.map(date => {
            // within a day, show trades first → last (chronological by entry time)
            const dayTrades = [...byDate[date]].sort((a, b) => (a.entry_time || '').localeCompare(b.entry_time || ''));
            const dayClosed = dayTrades.filter(t => !t.open);
            const dayPnl = dayClosed.reduce((s, t) => s + parseFloat(t.net_pnl || 0), 0);
            const dayWins = dayClosed.filter(t => parseFloat(t.net_pnl || 0) > 0).length;
            const dayWinTrades = dayClosed.filter(t => parseFloat(t.net_pnl || 0) > 0);
            const dayLossTrades = dayClosed.filter(t => parseFloat(t.net_pnl || 0) < 0);
            const dayAvgWin = dayWinTrades.length ? dayWinTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / dayWinTrades.length : null;
            const dayAvgLoss = dayLossTrades.length ? dayLossTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / dayLossTrades.length : null;
            const dayGrossWins = dayWinTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0);
            const dayGrossLosses = Math.abs(dayLossTrades.reduce((s, t) => s + parseFloat(t.net_pnl), 0));
            const dayProfitFactor = dayGrossLosses > 0 ? dayGrossWins / dayGrossLosses : (dayGrossWins > 0 ? Infinity : null);
            const dayBestTrade = dayWinTrades.length ? Math.max(...dayWinTrades.map(t => parseFloat(t.net_pnl))) : null;
            const dayWorstTrade = dayLossTrades.length ? Math.min(...dayLossTrades.map(t => parseFloat(t.net_pnl))) : null;
            const collapsed = collapsedDays[date];
            const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(date + 'T00:00:00').getDay()];

            return (
              <div key={date} style={{ background: '#18181b', borderRadius: 10, border: '1px solid #27272a', overflow: 'hidden' }}>
                <div style={s.dayHeader} onClick={() => toggleDay(date)}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtDate(date)} <span style={{ color: '#52525b', fontWeight: 400, fontSize: 12 }}>{dow}</span></span>
                  <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ color: '#71717a' }}>{dayTrades.length} trade{dayTrades.length !== 1 ? 's' : ''}</span>
                    {dayClosed.length > 0 && <>
                      <span style={{ color: pnlColor(dayPnl), fontWeight: 600 }}>{fmtPnl(dayPnl)}</span>
                      <span style={{ color: '#71717a' }}>Win: {dayClosed.length ? ((dayWins / dayClosed.length) * 100).toFixed(0) : 0}%</span>
                      {dayAvgWin != null && <span style={{ color: '#22c55e' }}>Avg W: {fmtPnl(dayAvgWin)}</span>}
                      {dayAvgLoss != null && <span style={{ color: '#ef4444' }}>Avg L: {fmtPnl(dayAvgLoss)}</span>}
                      {dayProfitFactor != null && <span style={{ color: '#71717a' }}>PF: {dayProfitFactor === Infinity ? '∞' : dayProfitFactor.toFixed(2)}</span>}
                      {dayBestTrade != null && <span style={{ color: '#22c55e' }}>Best: {fmtPnl(dayBestTrade)}</span>}
                      {dayWorstTrade != null && <span style={{ color: '#ef4444' }}>Worst: {fmtPnl(dayWorstTrade)}</span>}
                    </>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end' }}>
                    {(() => {
                      // Levels belong to a NY session, and one calendar date can hold two of
                      // them (a 01:00 and a 23:00 trade are different sessions), so offer a
                      // button per session rather than one per date.
                      const sessions = [...new Set(dayTrades.map(t => (t.session_date || t.trade_date || '').slice(0, 10)).filter(Boolean))].sort();
                      const list = sessions.length ? sessions : [date.slice(0, 10)];
                      return list.map(sess => {
                        const hasLevels = levelDates.has(sess);
                        return (
                          <button key={sess}
                            title={`Levels for the ${sess} New York session`}
                            style={{ ...s.importBtn, ...(hasLevels ? { color: '#22c55e', borderColor: '#22c55e', background: '#22c55e18' } : {}) }}
                            onClick={e => handleImportLevels(e, sess)}>
                            {hasLevels ? '✓ Levels' : 'Import levels'}{list.length > 1 ? ` · ${sess.slice(8, 10)}-${sess.slice(5, 7)}` : ''}
                          </button>
                        );
                      });
                    })()}
                    {(() => {
                      const g = genState[date];
                      const label = g?.running ? `${g.done}/${g.total}…`
                        : g && g.failed?.length ? `⚠ ${g.failed.length} failed`
                        : g ? `✓ $${g.cost.toFixed(4)}`
                        : 'Generate data';
                      const tone = g?.running ? { color: '#a78bfa', borderColor: '#a78bfa' }
                        : g && g.failed?.length ? { color: '#f59e0b', borderColor: '#f59e0b', background: '#f59e0b18' }
                        : g ? { color: '#22c55e', borderColor: '#22c55e', background: '#22c55e18' }
                        : {};
                      return (
                        <button
                          title={g?.failed?.length ? `Failed: ${g.failed.join(', ')}` : 'Fetch candles, TPO and footprint for every trade this day'}
                          disabled={!!g?.running}
                          style={{ ...s.importBtn, ...tone, cursor: g?.running ? 'default' : 'pointer' }}
                          onClick={e => handleGenerate(e, date)}>
                          {label}
                        </button>
                      );
                    })()}
                    <span style={{ color: '#52525b', fontSize: 12 }}>{collapsed ? '▶' : '▼'}</span>
                  </div>
                </div>

                {!collapsed && (
                  <>
                    <div style={{ ...s.dayTrade, color: '#71717a', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, paddingTop: 8, paddingBottom: 8, cursor: 'default' }}>
                      <span>Time</span><span>Instrument</span><span>Dir</span><span>Qty</span><span>Entry</span><span>Exit</span><span>Gross P&L</span><span>Net P&L</span><span>Score</span><span>Tags</span>
                    </div>
                    {dayTrades.map(t => (
                      <div key={t.id} style={s.dayTrade}
                        onClick={() => navigate(`/trades/${t.id}`)}
                        onMouseEnter={e => e.currentTarget.style.background = '#1c1c1e'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        <span style={{ color: '#71717a' }}>{fmtTime(t.entry_time)}</span>
                        <span style={{ fontWeight: 600 }}>{t.instrument}</span>
                        <span style={{ color: t.direction === 'LONG' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{t.direction}</span>
                        <span>{t.quantity}</span>
                        <span>{parseFloat(t.entry_price).toString()}</span>
                        <span>{t.exit_price ? parseFloat(t.exit_price).toString() : <span style={{ color: '#52525b' }}>open</span>}</span>
                        <span style={{ color: pnlColor(t.gross_pnl) }}>{t.gross_pnl != null ? fmtPnl(t.gross_pnl) : '–'}</span>
                        <span style={{ color: pnlColor(t.net_pnl), fontWeight: 600 }}>
                          {t.open ? <span style={{ color: '#f59e0b', fontSize: 11 }}>OPEN</span> : t.net_pnl != null ? fmtPnl(t.net_pnl) : '–'}
                        </span>
                        <span><ScoreBadge score={t.ai_score} /></span>
                        <span>
                          {(t.tags || []).map(tg => (
                            <span key={tg.id} style={{ background: tg.color + '22', color: tg.color, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600, marginRight: 3 }}>{tg.name}</span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {levelsDate && <ImportLevelsModal date={levelsDate} onClose={() => { setLevelsDate(null); loadLevelDates(); }} />}
    </div>
  );
}
