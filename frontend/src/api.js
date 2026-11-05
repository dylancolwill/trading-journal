const BASE = '/api';

export async function getTrades(params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}/trades${q ? '?' + q : ''}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTrade(id) {
  const r = await fetch(`${BASE}/trades/${id}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function patchTrade(id, data) {
  const r = await fetch(`${BASE}/trades/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTrade(id) {
  const r = await fetch(`${BASE}/trades/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addTag(tradeId, tagId) {
  const r = await fetch(`${BASE}/trades/${tradeId}/tags/${tagId}`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeTag(tradeId, tagId) {
  const r = await fetch(`${BASE}/trades/${tradeId}/tags/${tagId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTags() {
  const r = await fetch(`${BASE}/tags`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createTag(name, color, group_name = '', group_color = '') {
  const r = await fetch(`${BASE}/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color, group_name, group_color }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveAiAnalysis(tradeId, ai_analysis) {
  const r = await fetch(`${BASE}/trades/${tradeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai_analysis }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function generateAiAnalysis(tradeId) {
  const r = await fetch(`${BASE}/trades/${tradeId}/analyze`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTag(id) {
  const r = await fetch(`${BASE}/tags/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function uploadImage(tradeId, file) {
  const fd = new FormData();
  fd.append('image', file);
  const r = await fetch(`${BASE}/images/${tradeId}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteImage(id) {
  const r = await fetch(`${BASE}/images/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getFootprint(tradeId, bar = 120) {
  const r = await fetch(`${BASE}/footprint/${tradeId}?bar=${bar}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchFootprint(tradeId, bar = 120, force = false) {
  const r = await fetch(`${BASE}/footprint/${tradeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bar, force }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getCandles(tradeId) {
  const r = await fetch(`${BASE}/candles/${tradeId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchCandles(tradeId) {
  const r = await fetch(`${BASE}/candles/${tradeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTpo(tradeId) {
  const r = await fetch(`${BASE}/tpo/${tradeId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchTpo(tradeId) {
  const r = await fetch(`${BASE}/tpo/${tradeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getLevelDates() {
  const r = await fetch(`${BASE}/levels/dates`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getLevelsForDate(date) {
  const r = await fetch(`${BASE}/levels?date=${date}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// session_date = the NY session these levels belong to (not the calendar day of the export).
export async function saveLevels(raw_text, session_date) {
  const r = await fetch(`${BASE}/levels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw_text, session_date }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed');
  return r.json();
}

export async function deleteLevels(id) {
  const r = await fetch(`${BASE}/levels/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Saved levels back out for re-import elsewhere (NinjaTrader replay, etc.).
export function levelsExportUrl(date, instrument, format = 'txt') {
  const q = new URLSearchParams({ date, format });
  if (instrument) q.set('instrument', instrument);
  return `${BASE}/levels/export?${q}`;
}

export async function getLevelsExport(date, instrument, format = 'txt') {
  const r = await fetch(levelsExportUrl(date, instrument, format));
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

export async function getLevelsForTrade(tradeId) {
  const r = await fetch(`${BASE}/levels/for-trade/${tradeId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getInstruments() {
  const r = await fetch(`${BASE}/trades/meta/instruments`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// --- AI Analysis (period reviews) ---

export async function getInsightsSummary(days = 30, instrument = '') {
  const q = new URLSearchParams({ days: String(days) });
  if (instrument) q.set('instrument', instrument);
  const r = await fetch(`${BASE}/insights/summary?${q}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getInsightReports(limit = 20) {
  const r = await fetch(`${BASE}/insights/reports?limit=${limit}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getInsightReport(id) {
  const r = await fetch(`${BASE}/insights/reports/${id}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteInsightReport(id) {
  const r = await fetch(`${BASE}/insights/reports/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function insightsAnalyzeUrl(days = 30, instrument = '') {
  const q = new URLSearchParams({ days: String(days) });
  if (instrument) q.set('instrument', instrument);
  return `${BASE}/insights/analyze?${q}`;
}

export async function importCsv(file, dateFormat = 'au') {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`${BASE}/import?dateFormat=${dateFormat}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function previewCsv(file, dateFormat = 'au') {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`${BASE}/import/preview?dateFormat=${dateFormat}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
