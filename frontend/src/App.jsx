import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import TradeList from './pages/TradeList';
import TradeDetail from './pages/TradeDetail';
import Import from './pages/Import';
import Dashboard from './pages/Dashboard';
import Tags from './pages/Tags';
import AIAnalysis from './pages/AIAnalysis';

const s = {
  nav: { background: '#18181b', borderBottom: '1px solid #27272a', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 32, height: 52 },
  logo: { fontWeight: 700, fontSize: 16, color: '#a78bfa', letterSpacing: -0.5, marginRight: 16 },
  link: { color: '#71717a', textDecoration: 'none', fontSize: 14, fontWeight: 500, padding: '4px 0', borderBottom: '2px solid transparent' },
  activeLink: { color: '#e1e1e6', borderBottomColor: '#a78bfa' },
};

export default function App() {
  return (
    <BrowserRouter>
      <nav style={s.nav}>
        <span style={s.logo}>Journal</span>
        {[['/', 'Dashboard'], ['/trades', 'Trades'], ['/import', 'Import'], ['/tags', 'Tags'], ['/ai', 'AI Analysis']].map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'} style={({ isActive }) => ({ ...s.link, ...(isActive ? s.activeLink : {}) })}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/trades" element={<TradeList />} />
        <Route path="/trades/:id" element={<TradeDetail />} />
        <Route path="/import" element={<Import />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/ai" element={<AIAnalysis />} />
      </Routes>
    </BrowserRouter>
  );
}
