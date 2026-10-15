const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamingFacts } = require('../streaming-diagnostics.js');
const names = { mai: 'MAI streaming' };
const duration = ms => `${ms} ms`;
const facts = metrics => streamingFacts(metrics, names, duration);
const attempt = {
  model: 'mai', startedMs: 100, connectedMs: 200,
  firstTranscriptMs: 500, lastTranscriptMs: 1800, transcriptEvents: 4,
  inputCompletedMs: 2100, endedMs: 32100, outcome: 'Failed', failureStage: 'finalize'
};

test('older and non-streaming history does not acquire misleading diagnostics', () => {
  assert.deepEqual(facts({}), []);
  assert.deepEqual(facts({ streamingAttempts: [] }), []);
});

test('completion timeout preserves the last intermediate text and exposes the final wait', () => {
  const rows = Object.fromEntries(facts({ stopMs: 2000, streamingAttempts: [attempt] }));
  assert.equal(rows['Stream 1'], 'MAI streaming · Failed while waiting for the completed transcript');
  assert.equal(rows['Stream 1 connection'], '100 ms to connect');
  assert.equal(rows['Stream 1 first text'], '400 ms after stream started');
  assert.equal(rows['Stream 1 last text'], '200 ms before Stop');
  assert.equal(rows['Stream 1 time without text'], '30300 ms before failure');
  assert.equal(rows['Stream 1 final wait'], '30000 ms after audio was sent');
  assert.equal(rows['Stream 1 text updates'], '4');
});

test('connection failure is distinct from a connected stream with no intermediate text', () => {
  const rows = Object.fromEntries(facts({ streamingAttempts: [
    { model: 'mai', startedMs: 0, endedMs: 15000, outcome: 'Failed', failureStage: 'connect' },
    { model: 'mai', startedMs: 16000, connectedMs: 16100, endedMs: 20000, outcome: 'Failed', failureStage: 'stream' }
  ] }));
  assert.equal(rows['Stream 1'], 'MAI streaming · Failed while connecting');
  assert.equal(rows['Stream 1 connection'], 'Not established');
  assert.equal(rows['Stream 1 last text'], 'No intermediate text received');
  assert.equal(rows['Stream 2'], 'MAI streaming · Failed while streaming audio');
  assert.equal(rows['Stream 2 connection'], '100 ms to connect');
  assert.equal(rows['Stream 2 last text'], 'No intermediate text received');
  assert(!('Stream 1 final wait' in rows));
});

test('successful recovery and cancellation keep their own outcome and timing origin', () => {
  const rows = Object.fromEntries(facts({ stopMs: 1000, streamingAttempts: [attempt,
    { ...attempt, startedMs: 33000, connectedMs: 33100, firstTranscriptMs: 34000, lastTranscriptMs: 34500,
      inputCompletedMs: 35000, endedMs: 35100, outcome: 'Completed', failureStage: null },
    { ...attempt, outcome: 'Cancelled', failureStage: null }
  ] }));
  assert.equal(rows['Stream 2'], 'MAI streaming · Completed');
  assert.equal(rows['Stream 2 first text'], '1000 ms after stream started');
  assert.equal(rows['Stream 2 last text'], '33500 ms after Stop');
  assert.equal(rows['Stream 2 final wait'], '100 ms after audio was sent');
  assert.equal(rows['Stream 3'], 'MAI streaming · Cancelled');
  assert.equal(rows['Stream 3 time without text'], '30300 ms before cancellation');
  assert.equal(rows['Stream 1'], 'MAI streaming · Failed while waiting for the completed transcript');
});

test('live diagnostics tolerate missing Stop and end-of-stream timestamps', () => {
  const rows = Object.fromEntries(facts({ streamingAttempts: [
    { ...attempt, outcome: 'Streaming', endedMs: null, inputCompletedMs: null }
  ] }));
  assert.equal(rows['Stream 1 last text'], '1700 ms after stream started');
  assert(!('Stream 1 final wait' in rows));
  assert(!('Stream 1 time without text' in rows));
});
