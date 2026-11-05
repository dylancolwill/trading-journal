// Wall-clock <-> UTC helpers, and the New York view of an instant.
//
// Trades are stored in the trader's local wall clock (TRADE_TZ, Australia/Sydney), but the
// market they trade runs on New York time. One Sydney calendar date routinely holds two NY
// sessions, so anything grouped "by day" must group by NY session, not by the stored date.

const LOCAL_TZ = process.env.TRADE_TZ || 'Australia/Sydney';
const NY_TZ = 'America/New_York';

// Interpret a "YYYY-MM-DD HH:MM[:SS]" wall-clock string in `tz` as a true UTC Date.
function wallTimeToUtc(tsStr, tz) {
  const ref = new Date(String(tsStr).replace(' ', 'T') + 'Z');
  const utcDate = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  return new Date(ref.getTime() + (utcDate.getTime() - tzDate.getTime()));
}

const toUtcMs = tsStr => (tsStr ? wallTimeToUtc(tsStr, LOCAL_TZ).getTime() : null);

// { date: 'YYYY-MM-DD', hour, minute } of an instant on the New York clock.
function nyParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour, minute: +parts.minute };
}

const shiftDate = (ymd, days) => {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// The CME session an instant belongs to, named by its NY closing date. Globex reopens at
// 18:00 ET, so an evening trade belongs to the next day's session.
function nySessionDate(ms) {
  const p = nyParts(ms);
  return p.hour >= 18 ? shiftDate(p.date, 1) : p.date;
}

// 09:30 ET on a given NY date, as UTC ms.
const rthOpenMs = nyDate => wallTimeToUtc(`${nyDate} 09:30:00`, NY_TZ).getTime();

// Minutes from that session's 09:30 ET open (negative = pre-market / overnight).
function minutesFromRthOpen(ms) {
  return Math.round((ms - rthOpenMs(nySessionDate(ms))) / 60000);
}

const fmtEt = ms => { const p = nyParts(ms); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`; };

module.exports = {
  LOCAL_TZ, NY_TZ, wallTimeToUtc, toUtcMs, nyParts, nySessionDate, rthOpenMs, minutesFromRthOpen, fmtEt, shiftDate,
};
