// Parse a pasted chart-levels snippet into normalized objects.
//
// Supports two line styles and MULTIPLE instrument blocks in one paste (each block
// starts with its own header line; blocks may be separated by a divider like "====").
//
//   Rich:
//     === NQ 09-26  —  2026-07-18 14:22 ===
//     LEVELS (horizontal lines & flat rays)
//       15234.50  Weekly S/R  (Labeled Ray, Red, 2026-07-18 09:31)
//     ZONES (rectangles)
//       15290.00 - 15275.00  Supply zone  (Extended Rectangle, CornflowerBlue, 2026-07-18 08:00)
//     TRENDS (sloped lines & rays)
//       15100.00 @ 07-18 08:00  →  15240.00 @ 07-18 10:30  Trendline  (Labeled Ray, Lime)
//
//   Minimal (markdown-ish):
//     # 6E SEP26 2026-07-18
//     # LEVELS
//     1.16565 test
//     # ZONES
//     1.16655-1.16645
//     # TRENDS
//       7606.75→7552.75 Fixed Range Volume Profile 2
//
// Meta in parens is optional: (Type, Color, Time). Missing colours get a default.

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const NUM = '-?\\d+(?:\\.\\d+)?';

const LEVEL_RE = new RegExp(`^\\s*(${NUM})(?:\\s+([^()]*?))?\\s*(?:\\(([^)]*)\\))?\\s*$`);
const ZONE_RE  = new RegExp(`^\\s*(${NUM})\\s*-\\s*(${NUM})(?:\\s+([^()]*?))?\\s*(?:\\(([^)]*)\\))?\\s*$`);
const ARROW = '(?:→|–>|—>|-+>)';
// Rich: p1 @ time -> p2 @ time  [label]  (meta)
const TREND_RICH_RE = new RegExp(`^\\s*(${NUM})\\s*@\\s*(\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})\\s*${ARROW}\\s*(${NUM})\\s*@\\s*(\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})(?:\\s+([^()]*?))?\\s*(?:\\(([^)]*)\\))?\\s*$`);
// Minimal: p1 -> p2  <rest is the label, verbatim>
const TREND_MIN_RE = new RegExp(`^\\s*(${NUM})\\s*${ARROW}\\s*(${NUM})\\s*(.*)$`);

const DEFAULT_LINE_COLOR = '#eab308';   // amber
const DEFAULT_ZONE_COLOR = '#3b82f6';   // blue
const DEFAULT_TREND_COLOR = '#a78bfa';  // purple

const stripLead = s => s.replace(/^[#=\s]+/, '');

// A header names the instrument and contains a date, e.g. "# 6E SEP26 2026-07-18".
// Data rows begin with a bare number, so they are excluded — but instruments that begin
// with a digit (6E, 6J, ...) are NOT, so we only reject a purely-numeric first token.
function parseHeader(line) {
  const dm = line.match(DATE_RE);
  if (!dm) return null;
  let before = stripLead(line.slice(0, dm.index)).replace(/[—–\-]\s*$/, '').trim();
  if (!before) return null;
  const first = before.split(/\s+/)[0];
  if (/^[\d.]+$/.test(first)) return null;            // "15234.50 ..." is a data row, not a header
  const after = line.slice(dm.index + dm[1].length);
  const tm = after.match(/(\d{2}:\d{2})/);
  return { instrument: before, date: dm[1], time: tm ? tm[1] : null };
}

function sectionOf(line) {
  const h = stripLead(line).toUpperCase();
  if (h.startsWith('LEVELS')) return 'levels';
  if (h.startsWith('ZONES')) return 'zones';
  if (h.startsWith('TRENDS')) return 'trends';
  return null;
}

const metaParts = str => (str ? str.split(',').map(s => s.trim()) : []);
const normDateTime = str => (str ? str.trim().slice(0, 16) : null);
const withYear = (mmddhhmm, year) => (mmddhhmm ? `${year}-${mmddhhmm.trim().replace(/\s+/, ' ')}`.slice(0, 16) : null);

// Parse the data lines of a single block into normalized objects.
function parseObjects(lines, year) {
  let section = null;
  const objects = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s*[#=\s]*\(\d+\s+object/i.test(line)) continue;   // "(4 objects)"
    if (/^\s*=+\s*$/.test(line)) continue;                   // "====" divider

    const sec = sectionOf(line);
    if (sec) { section = sec; continue; }
    if (parseHeader(line)) continue;
    if (!section) continue;

    let m;
    if (section === 'trends' && (m = line.match(TREND_RICH_RE))) {
      const meta = metaParts(m[6]);
      objects.push({
        kind: 'trend', label: (m[5] || '').trim(), type: meta[0] || '', color: meta[1] || DEFAULT_TREND_COLOR,
        p1: parseFloat(m[1]), at1: withYear(m[2], year),
        p2: parseFloat(m[3]), at2: withYear(m[4], year),
      });
    } else if (section === 'trends' && (m = line.match(TREND_MIN_RE))) {
      objects.push({
        kind: 'trend', label: (m[3] || '').trim(), type: '', color: DEFAULT_TREND_COLOR,
        p1: parseFloat(m[1]), at1: null, p2: parseFloat(m[2]), at2: null,
      });
    } else if (section === 'zones' && (m = line.match(ZONE_RE))) {
      const meta = metaParts(m[4]);
      const a = parseFloat(m[1]), b = parseFloat(m[2]);
      objects.push({
        kind: 'zone', label: (m[3] || '').trim(), type: meta[0] || '', color: meta[1] || DEFAULT_ZONE_COLOR,
        high: Math.max(a, b), low: Math.min(a, b), at: normDateTime(meta[2]),
      });
    } else if (section === 'levels' && (m = line.match(LEVEL_RE))) {
      const meta = metaParts(m[3]);
      const type = meta[0] || '';
      objects.push({
        kind: /ray/i.test(type) ? 'ray' : 'line', label: (m[2] || '').trim(), type, color: meta[1] || DEFAULT_LINE_COLOR,
        price: parseFloat(m[1]), at: normDateTime(meta[2]),
      });
    }
  }
  return objects;
}

// Parse one or more instrument blocks. Returns { ok, blocks: [{ instrument, base, date, time, objects, raw }] }.
function parseLevels(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const headerIdxs = [];
  lines.forEach((line, i) => { if (line.trim() && parseHeader(line)) headerIdxs.push(i); });
  if (!headerIdxs.length) {
    return { ok: false, error: 'No header found (expected a line with the instrument and a YYYY-MM-DD date)' };
  }

  const blocks = [];
  for (let h = 0; h < headerIdxs.length; h++) {
    const start = headerIdxs[h];
    const end = h + 1 < headerIdxs.length ? headerIdxs[h + 1] : lines.length;
    const blockLines = lines.slice(start, end);
    const hdr = parseHeader(lines[start]);
    const base = hdr.instrument.split(/\s+/)[0].toUpperCase();
    const objects = parseObjects(blockLines, hdr.date.slice(0, 4));
    blocks.push({
      instrument: hdr.instrument, base, date: hdr.date, time: hdr.time,
      objects, raw: blockLines.join('\n').trim(),
    });
  }
  return { ok: true, blocks };
}

module.exports = { parseLevels };
