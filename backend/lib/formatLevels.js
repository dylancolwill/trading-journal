// Serialize stored level objects back out for re-import elsewhere (NinjaTrader replay, etc.).
//
// Two formats:
//   text — the same markdown-ish block parseLevels() reads, so exports round-trip
//   csv  — flat one-row-per-object, for a NinjaTrader-side importer to read directly
//
// Times are the wall-clock strings captured at import ("YYYY-MM-DD HH:MM"), interpreted
// in TRADE_TZ; the text header states the zone so the consumer isn't guessing.

const { DEFAULT_LINE_COLOR, DEFAULT_ZONE_COLOR, DEFAULT_TREND_COLOR } = require('./parseLevels');

const DEFAULT_COLOR = {
  line: DEFAULT_LINE_COLOR, ray: DEFAULT_LINE_COLOR,
  zone: DEFAULT_ZONE_COLOR, trend: DEFAULT_TREND_COLOR,
};

const num = n => (n == null || Number.isNaN(n) ? '' : String(n));

// Labels and meta fields sit inside "label (Type, Color, Time)" — parens end the label and
// commas split the meta, so neither may survive in the values themselves.
const safeLabel = s => String(s || '').replace(/[()]/g, '').trim();
const safeMeta = s => String(s || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();

// "(Type, Color, Time)" — trailing empty fields are trimmed, and the whole block is
// dropped when the object carries nothing worth stating (a colour the parser would have
// defaulted to anyway is not worth stating).
function metaFields(o, extra) {
  const color = safeMeta(o.color) === DEFAULT_COLOR[o.kind] ? '' : safeMeta(o.color);
  const fields = [safeMeta(o.type), color, ...extra];
  while (fields.length && !fields[fields.length - 1]) fields.pop();
  return fields;
}

function meta(o, extra = [safeMeta(o.at)]) {
  const fields = metaFields(o, extra);
  return fields.length ? `  (${fields.join(', ')})` : '';
}

// The trend line format wants "MM-DD HH:MM"; stored values carry the year.
const shortTime = at => (at ? String(at).slice(5, 16) : '');

function levelLine(o) {
  const label = safeLabel(o.label);
  return `${num(o.price)}${label ? ' ' + label : ''}${meta(o)}`;
}

function zoneLine(o) {
  const label = safeLabel(o.label);
  const tail = label ? ' ' + label : '';
  // A rectangle with two anchors keeps them; a zone that is only a price band stays compact.
  if (o.at && o.at2) return `${num(o.high)} @ ${o.at} → ${num(o.low)} @ ${o.at2}${tail}${meta(o)}`;
  return `${num(o.high)}-${num(o.low)}${tail}${meta(o)}`;
}

function trendLine(o) {
  const label = safeLabel(o.label);
  const tail = `${label ? ' ' + label : ''}`;
  // Trend times live in the anchors, so the meta block carries only type + colour.
  if (o.at1 && o.at2) {
    return `${num(o.p1)} @ ${shortTime(o.at1)} → ${num(o.p2)} @ ${shortTime(o.at2)}${tail}${meta(o, [])}`;
  }
  return `${num(o.p1)}→${num(o.p2)}${tail}`;
}

// One "# INSTRUMENT DATE" block per saved row.
function rowToText(row, tz) {
  const objects = row.levels || [];
  const date = String(row.trade_date).slice(0, 10);
  const out = [`# ${row.instrument} ${date}`];
  if (tz) out.push(`# TZ ${tz}`);

  const levels = objects.filter(o => o.kind === 'line' || o.kind === 'ray');
  const zones = objects.filter(o => o.kind === 'zone');
  const trends = objects.filter(o => o.kind === 'trend');

  if (levels.length) out.push('', '# LEVELS', ...levels.map(levelLine));
  if (zones.length) out.push('', '# ZONES', ...zones.map(zoneLine));
  if (trends.length) out.push('', '# TRENDS', ...trends.map(trendLine));
  return out.join('\n');
}

function toText(rows, tz) {
  return rows.map(r => rowToText(r, tz)).join('\n\n') + '\n';
}

const CSV_HEADER = ['kind', 'instrument', 'session_date', 'price1', 'price2', 'label', 'type', 'color', 'start_time', 'end_time'];

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// price1/price2 by kind: line & ray -> price; zone -> high, low; trend -> p1, p2.
function csvRow(o, row) {
  const date = String(row.trade_date).slice(0, 10);
  const common = [row.instrument, date];
  if (o.kind === 'zone') return ['zone', ...common, num(o.high), num(o.low), o.label, o.type, o.color, o.at, o.at2];
  if (o.kind === 'trend') return ['trend', ...common, num(o.p1), num(o.p2), o.label, o.type, o.color, o.at1, o.at2];
  return [o.kind, ...common, num(o.price), '', o.label, o.type, o.color, o.at, ''];
}

function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    for (const o of row.levels || []) lines.push(csvRow(o, row).map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { toText, toCsv };
