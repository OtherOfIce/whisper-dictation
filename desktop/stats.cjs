'use strict';

// Count runs of letters or numbers, keeping apostrophes and hyphens inside a word.
// Unicode property escapes make this work for transcripts outside English.
function countWords(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  return value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length || 0;
}

function entryText(entry) {
  if (typeof entry?.rawText === 'string') return entry.rawText;
  return typeof entry?.text === 'string' ? entry.text : '';
}

function localDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getWordStats(history, now = new Date()) {
  const todayKey = localDayKey(now);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - 6);
  const recentKeys = new Set();
  for (let day = new Date(start); day <= now; day.setDate(day.getDate() + 1)) recentKeys.add(localDayKey(day));

  let total = 0;
  let today = 0;
  let last7Days = 0;
  for (const entry of Array.isArray(history) ? history : []) {
    const words = countWords(entryText(entry));
    total += words;
    const started = entry?.metrics?.started;
    const date = started ? new Date(started) : null;
    if (!date || Number.isNaN(date.getTime())) continue;
    const key = localDayKey(date);
    if (key === todayKey) today += words;
    if (recentKeys.has(key)) last7Days += words;
  }
  return { total, today, last7Days };
}

function summarizeCosts(rows) {
  const models = new Map();
  let voice = 0, cleanup = 0, voiceCount = 0, cleanupCount = 0;
  for (const cost of rows) {
    if (!cost || !['voice', 'cleanup'].includes(cost.category) || typeof cost.model !== 'string' || !Number.isFinite(cost.amount) || cost.amount < 0) continue;
    const count = Number.isSafeInteger(cost.requests) && cost.requests >= 0 ? cost.requests : 1;
    if (cost.category === 'voice') { voice += cost.amount; voiceCount += count; }
    else { cleanup += cost.amount; cleanupCount += count; }
    const key = `${cost.category}\0${cost.model}`;
    const current = models.get(key) || { category: cost.category, model: cost.model, amount: 0 };
    current.amount += cost.amount; models.set(key, current);
  }
  return { voice, cleanup, voiceCount, cleanupCount, models: [...models.values()].sort((a, b) => a.category.localeCompare(b.category) || b.amount - a.amount) };
}

function getCostStats(history, since = null, includeModels = []) {
  const rows = [];
  for (const entry of Array.isArray(history) ? history : []) {
    for (const version of [entry, ...(Array.isArray(entry?.alternatives) ? entry.alternatives : [])]) {
      const started = new Date(version?.metrics?.transcribedAt || version?.metrics?.started);
      for (const cost of Array.isArray(version?.metrics?.costs) ? version.metrics.costs : []) {
        // The activity ledger only covers OpenRouter. Costs recorded locally for
        // providers outside it (xAI and Vercel streaming estimates) are always kept.
        if (since && started < since && !includeModels.includes(cost?.model)) continue;
        rows.push(cost);
      }
    }
  }
  return summarizeCosts(rows);
}

// Models whose spend can never appear in the OpenRouter activity ledger.
const nonLedgerModels = ['grok-voice-transcribe-2.0', 'microsoft/mai-transcribe-2-streaming'];

function getDisplayedCostStats(history, ledger, now = new Date()) {
  if (!Array.isArray(ledger?.rows)) return { ...getCostStats(history), source: 'history' };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const remote = ledger.rows;
  const localToday = getCostStats(history, today, nonLedgerModels).models;
  return { ...summarizeCosts([...remote, ...localToday]), source: 'activity', through: ledger.through, importedAt: ledger.importedAt };
}

module.exports = { countWords, getWordStats, getCostStats, getDisplayedCostStats };
