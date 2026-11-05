const { parse } = require('csv-parse/sync');

// USD value of a 1.0 price move per contract for common futures
const POINT_VALUES = {
  // Equity index
  'ES': 50, 'MES': 5,
  'NQ': 20, 'MNQ': 2,
  'YM': 5, 'MYM': 0.5,
  'RTY': 50, 'M2K': 5,
  // FX futures (contract size in foreign currency units)
  '6E': 125000, '6B': 62500, '6A': 100000,
  '6C': 100000, '6S': 125000, '6N': 100000,
  '6J': 12500000, '6M': 500000,
  // Energy
  'CL': 1000, 'MCL': 100, 'NG': 10000, 'RB': 42000, 'HO': 42000,
  // Metals
  'GC': 100, 'MGC': 10, 'SI': 5000, 'HG': 25000,
  // Grains
  'ZC': 50, 'ZW': 50, 'ZS': 50, 'ZM': 100,
  // Rates
  'ZB': 1000, 'ZN': 1000, 'ZF': 1000, 'ZT': 2000,
};

function getPointValue(instrument) {
  const base = (instrument || '').split(/\s+/)[0].toUpperCase();
  return POINT_VALUES[base] || 1;
}

// Format a Date object as "YYYY-MM-DD HH:MM:SS" using local time — no UTC conversion
function fmtTs(d) {
  if (!d) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseDateTime(str) {
  if (!str) return null;
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    // ISO — parse components to avoid JS timezone shift
    const [datePart, timePart = '00:00:00'] = str.split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi, s] = timePart.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi, s);
  }

  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return null;

  let [, a, b, year, h, min, sec = '0', ampm] = match;
  a = parseInt(a); b = parseInt(b); h = parseInt(h);

  // If first number > 12 it must be day (d/m/y); else default AU (d/m/y)
  let month, day;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { day = b; month = a; }
  else { day = a; month = b; }

  if (ampm) {
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
  }

  // Local time — no UTC conversion
  return new Date(parseInt(year), month - 1, day, h, parseInt(min), parseInt(sec || '0'));
}

function parseMoney(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, '')) || 0;
}

function parseNTCsv(content, dateFormat = 'au') {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  return records.map(r => {
    const timeStr = r['Time'] || r['time'] || '';
    let dt = parseDateTime(timeStr);

    if (dateFormat === 'us' && dt) {
      const match = timeStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (match) {
        const a = parseInt(match[1]), b = parseInt(match[2]);
        // Only swap if both <= 12 (ambiguous) — treat as m/d/y
        if (a <= 12 && b <= 12) {
          const rest = timeStr.slice(match[0].length);
          const [, amatch, bmatch, ymatch] = match;
          dt = parseDateTime(`${bmatch}/${amatch}/${ymatch}${rest}`);
        }
      }
    }

    return {
      contract: (r['Instrument'] || '').trim(),
      instrument: (r['Instrument'] || '').trim().split(/\s+/)[0].toUpperCase(),
      action: (r['Action'] || '').trim(),
      quantity: Math.abs(parseInt(r['Quantity'] || '0')),
      price: parseFloat(r['Price'] || '0'),
      time: dt,          // Date object for arithmetic
      entryOrExit: (r['E/X'] || '').trim(),
      position: parseInt(r['Position'] || '0'),
      orderId: (r['Order ID'] || '').trim(),
      commission: parseMoney(r['Commission']),
      account: (r['Account'] || '').trim(),
      connection: (r['Connection'] || '').trim(),
    };
  }).filter(r => r.instrument && r.account && r.quantity > 0);
}

// Merge fills that are copy-traded to multiple accounts, and partial fills of one order:
// fills within 2 seconds sharing instrument + action + price + E/X → merged into one.
// E/X must match: a "Sell 3" closing a long and a "Sell 3" opening a short can land on the
// same second at the same price, and fusing them loses the first trade's exit entirely.
function mergeCrossAccountFills(fills, windowMs = 2000) {
  if (!fills || fills.length === 0) return fills;

  const sorted = [...fills].sort((a, b) =>
    (a.time ? a.time.getTime() : 0) - (b.time ? b.time.getTime() : 0)
  );

  const used = new Set();
  const merged = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const f = sorted[i];
    const tA = f.time ? f.time.getTime() : 0;
    const group = [i];

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const g = sorted[j];
      const tB = g.time ? g.time.getTime() : 0;
      if (tB - tA > windowMs) break;
      if (g.instrument === f.instrument &&
          g.action.toLowerCase() === f.action.toLowerCase() &&
          (g.entryOrExit || '').toLowerCase() === (f.entryOrExit || '').toLowerCase() &&
          Math.abs(g.price - f.price) < 0.000001) {
        group.push(j);
      }
    }

    const groupFills = group.map(idx => sorted[idx]);
    const totalQty = groupFills.reduce((s, ff) => s + ff.quantity, 0);
    const totalComm = groupFills.reduce((s, ff) => s + ff.commission, 0);
    const connections = [...new Set(groupFills.map(ff => ff.connection || ff.account).filter(Boolean))];
    merged.push({
      ...f,
      quantity: totalQty,
      commission: totalComm,
      account: connections.join('+'),
      connection: connections.join('+'),
    });
    group.forEach(idx => used.add(idx));
  }

  return merged;
}

function groupIntoTrades(fills) {
  const mergedFills = mergeCrossAccountFills(fills);

  // Group by instrument only (accounts already merged)
  const groups = {};
  for (const fill of mergedFills) {
    if (!groups[fill.instrument]) groups[fill.instrument] = [];
    groups[fill.instrument].push(fill);
  }

  const trades = [];

  for (const [instrument, groupFills] of Object.entries(groups)) {
    groupFills.sort((a, b) =>
      (a.time ? a.time.getTime() : 0) - (b.time ? b.time.getTime() : 0)
    );

    let currentFills = [];
    let position = 0;

    for (const fill of groupFills) {
      const delta = fill.action.toLowerCase() === 'buy' ? fill.quantity : -fill.quantity;
      const prevPosition = position;
      position += delta;
      currentFills.push(fill);

      if (position === 0 && currentFills.length > 0) {
        trades.push(buildTrade(instrument, currentFills));
        currentFills = [];
      } else if (prevPosition !== 0 && position !== 0 && Math.sign(prevPosition) !== Math.sign(position)) {
        // One fill reversed the position — long 3 then selling 5 leaves short 2, not short 5.
        // Split it in two: the part that closes the old trade (so it isn't left looking like
        // it never exited) and the part that opens the new one, commission pro-rata.
        const closeQty = Math.abs(prevPosition);
        const openQty = Math.abs(position);
        const part = (qty) => ({ ...fill, quantity: qty, commission: fill.commission * (qty / fill.quantity) });
        currentFills[currentFills.length - 1] = part(closeQty);
        trades.push(buildTrade(instrument, currentFills));
        currentFills = [part(openQty)];
      }
    }

    if (currentFills.length > 0) {
      const t = buildTrade(instrument, currentFills);
      t.open = true;
      t.exit_price = null;
      t.gross_pnl = null;
      t.net_pnl = null;
      trades.push(t);
    }
  }

  return trades;
}

function buildTrade(instrument, fills) {
  const firstFill = fills[0];
  const direction = firstFill.action.toLowerCase() === 'buy' ? 'LONG' : 'SHORT';

  const entryFills = fills.filter(f =>
    direction === 'LONG' ? f.action.toLowerCase() === 'buy' : f.action.toLowerCase() === 'sell'
  );
  const exitFills = fills.filter(f =>
    direction === 'LONG' ? f.action.toLowerCase() === 'sell' : f.action.toLowerCase() === 'buy'
  );

  const entryQty = entryFills.reduce((s, f) => s + f.quantity, 0);
  const exitQty = exitFills.reduce((s, f) => s + f.quantity, 0);
  const tradedQty = Math.min(entryQty, exitQty) || entryQty;

  const avgEntry = entryFills.reduce((s, f) => s + f.price * f.quantity, 0) / (entryQty || 1);
  const avgExit = exitQty > 0
    ? exitFills.reduce((s, f) => s + f.price * f.quantity, 0) / exitQty
    : null;

  const totalCommission = fills.reduce((s, f) => s + f.commission, 0);
  const pointValue = getPointValue(instrument);

  let grossPnl = null;
  if (avgExit !== null) {
    grossPnl = direction === 'LONG'
      ? (avgExit - avgEntry) * tradedQty * pointValue
      : (avgEntry - avgExit) * tradedQty * pointValue;
  }

  const netPnl = grossPnl !== null ? grossPnl - totalCommission : null;

  const sortedTimes = fills.map(f => f.time).filter(Boolean).sort((a, b) => a - b);
  const entryTimeDate = sortedTimes[0] || null;
  const exitTimeDate = exitQty > 0 ? sortedTimes[sortedTimes.length - 1] : null;

  const tradeDate = entryTimeDate
    ? `${entryTimeDate.getFullYear()}-${String(entryTimeDate.getMonth() + 1).padStart(2, '0')}-${String(entryTimeDate.getDate()).padStart(2, '0')}`
    : new Date().toISOString().slice(0, 10);

  const connections = [...new Set(fills.map(f => f.account).filter(Boolean))];
  const account = connections.join('+') || 'unknown';

  return {
    account,
    instrument,
    trade_date: tradeDate,
    direction,
    quantity: tradedQty,
    entry_price: avgEntry,
    exit_price: avgExit,
    gross_pnl: grossPnl !== null ? +grossPnl.toFixed(2) : null,
    commission: +totalCommission.toFixed(2),
    net_pnl: netPnl !== null ? +netPnl.toFixed(2) : null,
    open: false,
    entry_time: fmtTs(entryTimeDate),   // "YYYY-MM-DD HH:MM:SS" string, no tz
    exit_time: fmtTs(exitTimeDate),
    fills,
  };
}

module.exports = { parseNTCsv, groupIntoTrades, fmtTs, getPointValue };
