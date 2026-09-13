const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectTimings } = require('../model.cjs');
const { metrics } = require('./fixtures.cjs');
test('default timeline excludes recording and cleanup from duration and rows', () => {
  const view = projectTimings(metrics);
  assert.equal(view.duration, 1360);
  assert(!view.rows.some(row => ['Recording', 'Open microphone'].includes(row.name) || row.name.includes('Clipboard cleanup')));
  assert.equal(view.rows[0].start, 0);
});
test('full session is opt-in', () => { const view = projectTimings(metrics, true); assert.equal(view.duration, 20460); assert(view.rows.some(row => row.name === 'Recording')); });
test('background work crossing Stop is clipped rather than double counted', () => {
  const view = projectTimings({ ...metrics, rows: [{ name: 'Wait for response', startMs: 18000, durationMs: 600 }] });
  assert.equal(view.rows[0].start, 0); assert.equal(view.rows[0].duration, 200);
});
test('work completed while speaking does not distort post-stop chart', () => {
  const view = projectTimings({ ...metrics, rows: [{ name: 'Prepare request', startMs: 500, durationMs: 40 }] });
  assert.equal(view.rows.length, 0); assert.equal(view.completedEarly, 1);
});
