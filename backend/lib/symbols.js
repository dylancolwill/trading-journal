// Micro and e-mini contracts quote the same price as their full-size parent — MES prints
// the same 7831.25 as ES — so levels drawn on one chart apply verbatim to the other.
// Collapse both onto a single family root so a trade on MES finds levels saved under ES.

// Micros whose ticker isn't just "M" + parent.
const ALIAS = {
  M2K: 'RTY',   // Micro Russell 2000
  MBT: 'BTC',   // Micro Bitcoin
  MET: 'ETH',   // Micro Ether
  MJY: '6J', MCD: '6C', MSF: '6S',   // Micro JPY / CAD / CHF
  SIL: 'SI', QI: 'SI',               // Micro / e-mini Silver
  QG: 'NG',                          // e-mini Natural Gas
  QM: 'CL',                          // e-mini Crude
};

function baseSymbol(instrument) {
  return String(instrument || '').trim().split(/\s+/)[0].toUpperCase();
}

// ES -> ES, MES -> ES, M6E -> 6E, M2K -> RTY.
function rootOf(instrument) {
  const s = baseSymbol(instrument);
  if (ALIAS[s]) return ALIAS[s];
  // Anything else leading with M is a micro of the remainder (MES, MNQ, MGC, M6E).
  if (/^M[A-Z0-9]{2,3}$/.test(s)) return s.slice(1);
  return s;
}

// Do two instruments trade the same price series?
function sameFamily(a, b) {
  return rootOf(a) === rootOf(b);
}

module.exports = { baseSymbol, rootOf, sameFamily };
