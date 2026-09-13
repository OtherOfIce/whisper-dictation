const test = require('node:test');
const assert = require('node:assert/strict');
const { countWords, getWordStats } = require('../stats.cjs');

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
