const test = require('node:test');
const assert = require('node:assert/strict');
const { countWords, getWordStats, getCostStats, getDisplayedCostStats } = require('../stats.cjs');

test('counts Unicode words and ignores punctuation', () => {
  assert.equal(countWords("Hello, world! Café déjà-vu... 你好世界 — it's 2026."), 7);
});

test('uses rawText when present and falls back to text', () => {
  const history = [
    { rawText: 'one two', text: 'one', metrics: { started: '2026-09-11T09:00:00' } },
    { text: 'three four', metrics: { started: '2026-09-10T09:00:00' } },
  ];
  assert.deepEqual(getWordStats(history, new Date('2026-09-11T12:00:00')), { total: 4, today: 2, last7Days: 4 });
});

test('last seven days uses local calendar days, including today', () => {
  const history = [
    { text: 'today', metrics: { started: '2026-09-11T01:00:00' } },
    { text: 'six days ago', metrics: { started: '2026-09-05T01:00:00' } },
    { text: 'eight days ago', metrics: { started: '2026-09-03T01:00:00' } },
  ];
  assert.deepEqual(getWordStats(history, new Date('2026-09-11T12:00:00')), { total: 7, today: 1, last7Days: 4 });
});

test('groups provider-reported costs by purpose and selected model', () => {
  const history = [
    { metrics: { costs: [
      { category: 'voice', model: 'mai-transcribe-2-clean', amount: 0.0012 },
      { category: 'cleanup', model: 'luna', amount: 0.0003 }
    ] } },
    { metrics: { costs: [
      { category: 'voice', model: 'mai-transcribe-2-clean', amount: 0.0008 },
      { category: 'voice', model: 'gpt-transcribe', amount: 0.001 },
      { category: 'other', model: 'ignored', amount: 3 }
    ] } },
    { metrics: {} }
  ];
  assert.deepEqual(getCostStats(history), {
    voice: 0.003,
    cleanup: 0.0003,
    voiceCount: 3,
    cleanupCount: 1,
    models: [
      { category: 'cleanup', model: 'luna', amount: 0.0003 },
      { category: 'voice', model: 'mai-transcribe-2-clean', amount: 0.002 },
      { category: 'voice', model: 'gpt-transcribe', amount: 0.001 }
    ]
  });
});

test('combines OpenRouter activity with locally recorded costs from the current UTC day', () => {
  const history = [
    { metrics: { started: '2026-09-15T10:00:00Z', costs: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.002 }] } },
    { metrics: { started: '2026-09-14T10:00:00Z', costs: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 9 }] } }
  ];
  const balance = { costsThrough: '2026-09-14T00:00:00Z', costs: [
    { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.01 },
    { category: 'cleanup', model: 'openai/gpt-5.6-luna', amount: 0.003 }
  ] };
  assert.deepEqual(getDisplayedCostStats(history, balance, new Date('2026-09-15T12:00:00Z')), {
    voice: 0.012, cleanup: 0.003, voiceCount: 2, cleanupCount: 1,
    models: [
      { category: 'cleanup', model: 'openai/gpt-5.6-luna', amount: 0.003 },
      { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.012 }
    ],
    source: 'activity', through: '2026-09-14T00:00:00Z'
  });
});
