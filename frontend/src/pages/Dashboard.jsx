import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTrades } from '../api';

const s = {
  page: { padding: 24, maxWidth: 1100, margin: '0 auto' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 },
  card: { background: '#18181b', borderRadius: 10, padding: '18px 22px', border: '1px solid #27272a' },
  cardLabel: { fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  cardValue: { fontSize: 26, fontWeight: 700 },
  section: { background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 24 },
};

function pnlColor(v) { return parseFloat(v) >= 0 ? '#22c55e' : '#ef4444'; }

function pad(n) { return String(n).padStart(2, '0'); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export default function Dashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [trades, setTrades] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    const from = `${year}-${pad(month + 1)}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const to = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
    getTrades({ from, to }).then(setTrades).catch(console.error);
  }, [year, month]);

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };

  const closed = trades.filter(t => !t.open);
  const totalPnl = closed.reduce((s, t) => s + parseFloat(t.net_pnl || 0), 0);
  const wins = closed.filter(t => parseFloat(t.net_pnl || 0) > 0);
  const losses = closed.filter(t => parseFloat(t.net_pnl || 0) <= 0);
  const winRate = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0';
  const avgWin = wins.length ? (wins.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / wins.length) : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + parseFloat(t.net_pnl), 0) / losses.length) : 0;

  // Group by date for calendar
  const byDate = {};
  for (const t of trades) {
    const d = typeof t.trade_date === 'string' ? t.trade_date.slice(0, 10) : '';
    if (!d) continue;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  }

  const dayPnl = {};
  for (const [d, ts] of Object.entries(byDate)) {
    const closedTs = ts.filter(t => !t.open);
    dayPnl[d] = closedTs.reduce((s, t) => s + parseFloat(t.net_pnl || 0), 0);
  }

  // Calendar grid
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array(firstDow).fill(null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );

  const isToday = (d) => {
    const t = new Date();
    return d === t.getDate() && month === t.getMonth() && year === t.getFullYear();
  };

  return (
    <div style={s.page}>
      <div style={s.grid}>
        {[
          ['Net P&L', `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, pnlColor(totalPnl)],
          ['Trades', closed.length, '#e1e1e6'],
          ['Win Rate', `${winRate}%`, parseFloat(winRate) >= 50 ? '#22c55e' : '#ef4444'],
          ['Avg Win / Loss', `$${avgWin.toFixed(0)} / $${avgLoss.toFixed(0)}`, '#e1e1e6'],
        ].map(([label, value, color]) => (
          <div key={label} style={s.card}>
            <div style={s.cardLabel}>{label}</div>
            <div style={{ ...s.cardValue, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={s.section}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{MONTHS[month]} {year}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={prevMonth} style={{ background: '#27272a', border: 'none', color: '#a1a1aa', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13 }}>◀</button>
            <button onClick={nextMonth} style={{ background: '#27272a', border: 'none', color: '#a1a1aa', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13 }}>▶</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {DAYS.map(d => (
            <div key={d} style={{ textAlign: 'center', fontSize: 11, color: '#52525b', fontWeight: 600, padding: '4px 0', letterSpacing: 0.5 }}>{d}</div>
          ))}
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />;
            const dateKey = `${year}-${pad(month + 1)}-${pad(day)}`;
            const pnl = dayPnl[dateKey];
            const hasTrades = pnl !== undefined;
            const tradeCount = byDate[dateKey]?.length || 0;
            const today = isToday(day);
            const profit = hasTrades && pnl >= 0;
            const loss = hasTrades && pnl < 0;

            return (
              <div key={dateKey}
                onClick={() => hasTrades && navigate(`/trades?from=${dateKey}&to=${dateKey}`)}
                style={{
                  background: profit ? '#052e16' : loss ? '#1c0a09' : '#09090b',
                  border: `1px solid ${today ? '#a78bfa' : profit ? '#166534' : loss ? '#7f1d1d' : '#27272a'}`,
                  borderRadius: 8,
                  padding: '8px 6px',
                  textAlign: 'center',
                  minHeight: 64,
                  cursor: hasTrades ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                }}>
                <div style={{ fontSize: 12, color: today ? '#a78bfa' : '#71717a', fontWeight: today ? 700 : 400 }}>{day}</div>
                {hasTrades && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: profit ? '#22c55e' : '#ef4444', lineHeight: 1 }}>
                      {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(0)}
                    </div>
                    <div style={{ fontSize: 10, color: '#52525b' }}>{tradeCount} trade{tradeCount !== 1 ? 's' : ''}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
