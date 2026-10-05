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

test('includes alternate transcription costs without counting alternate words', () => {
  const history = [{
    text: 'primary words', metrics: { started: '2026-09-15T10:00:00Z', costs: [{ category: 'voice', model: 'primary', amount: 0.001 }] },
    alternatives: [{ id: 'alt', text: 'these alternate words are not additional dictation', metrics: { started: '2026-09-15T10:01:00Z', costs: [{ category: 'voice', model: 'alternate', amount: 0.002 }] } }]
  }];
  assert.equal(getWordStats(history, new Date('2026-09-15T12:00:00Z')).total, 2);
  assert.equal(getCostStats(history).voice, 0.003);
});

test('combines OpenRouter activity with locally recorded costs from the current UTC day', () => {
  const history = [
    { metrics: { started: '2026-09-15T10:00:00Z', costs: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.002 }] } },
    { metrics: { started: '2026-09-14T10:00:00Z', costs: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 9 }] } }
  ];
  const ledger = { through: '2026-09-14T00:00:00Z', importedAt: '2026-09-15T11:00:00Z', rows: [
    { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.01 },
    { category: 'cleanup', model: 'openai/gpt-5.6-luna', amount: 0.003 }
  ] };
  assert.deepEqual(getDisplayedCostStats(history, ledger, new Date('2026-09-15T12:00:00Z')), {
    voice: 0.012, cleanup: 0.003, voiceCount: 2, cleanupCount: 1,
    models: [
      { category: 'cleanup', model: 'openai/gpt-5.6-luna', amount: 0.003 },
      { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.012 }
    ],
    source: 'activity', through: '2026-09-14T00:00:00Z', importedAt: '2026-09-15T11:00:00Z'
  });
});

test('keeps older direct xAI estimates when OpenRouter activity is imported', () => {
  const history = [
    { metrics: { started: '2026-09-15T10:00:00Z', costs: [{ category: 'voice', model: 'grok-voice-transcribe-2.0', amount: 0.004 }] } },
    { metrics: { started: '2026-09-14T10:00:00Z', costs: [{ category: 'voice', model: 'grok-voice-transcribe-2.0', amount: 0.002 }] } },
    { metrics: { started: '2026-09-14T10:00:00Z', costs: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 9 }] } }
  ];
  const ledger = { through: '2026-09-14T00:00:00Z', importedAt: '2026-09-15T11:00:00Z', rows: [
    { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.01 }
  ] };
  assert.deepEqual(getDisplayedCostStats(history, ledger, new Date('2026-09-15T12:00:00Z')), {
    voice: 0.016, cleanup: 0, voiceCount: 2, cleanupCount: 0,
    models: [
      { category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.01 },
      { category: 'voice', model: 'grok-voice-transcribe-2.0', amount: 0.006 }
    ],
    source: 'activity', through: '2026-09-14T00:00:00Z', importedAt: '2026-09-15T11:00:00Z'
  });
});

test('keeps Vercel gateway spend when importing the OpenRouter ledger', () => {
  const history = [{ metrics: { started: '2026-09-14T10:00:00Z', costs: [
    { category: 'voice', model: 'microsoft/mai-transcribe-2-streaming', amount: 0.005 }
  ] } }];
  const ledger = { rows: [{ category: 'voice', model: 'microsoft/mai-transcribe-2', amount: 0.01 }] };
  const result = getDisplayedCostStats(history, ledger, new Date('2026-09-15T12:00:00Z'));
  assert.equal(result.voice, 0.015);
});
