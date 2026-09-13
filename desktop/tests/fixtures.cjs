const metrics = {
  started: new Date().toISOString(), outcome: 'Pasted', audioSeconds: 18.4, audioBytes: 588800,
  requestBytes: 143400, elapsedMs: 20460, stopMs: 18400, pasteMs: 19760, maxUiGapMs: 39,
  rows: [
    { name: 'Recording', startMs: 0, durationMs: 18400 },
    { name: 'Open microphone', startMs: 0, durationMs: 15 },
    { name: 'Stop microphone', startMs: 18400, durationMs: 32 },
    { name: 'Part 1 · Compress audio', startMs: 18432, durationMs: 58 },
    { name: 'Part 1 · Prepare request', startMs: 18490, durationMs: 4 },
    { name: 'Part 1 · Connect / send request', startMs: 18494, durationMs: 14 },
    { name: 'Part 1 · Write audio to transport', startMs: 18508, durationMs: 16 },
    { name: 'Part 1 · Wait for response headers', startMs: 18524, durationMs: 1231 },
    { name: 'Part 1 · Read / parse transcript', startMs: 19755, durationMs: 2 },
    { name: 'Paste / wait for released keys', startMs: 19757, durationMs: 3 },
    { name: 'Clipboard cleanup (after paste)', startMs: 19760, durationMs: 700 }
  ]
};
const texts = [
  'I think the simplest version is the right place to start. Let’s make it feel effortless, then build from there.',
  'A quick thought for tomorrow: leave a little more space between the ideas. The important part is making it easy to come back and pick up where we left off.',
  'This is so much better than typing everything out. I can just say what I’m thinking and keep moving.',
  'Remember to take a look at the new designs before our meeting on Friday.'
];
module.exports = {
  metrics,
  history: texts.map((text, i) => ({ id: `demo-${i}`, text, metrics: { ...metrics, started: new Date(Date.now() - i * 3600000).toISOString() } })),
  settings: { hasKey: true, hasBalanceKey: false, liveChunks: false, dictionaryTerms: [] },
  balance: { kind: 'account', remaining: 18.42, usage: 1.5832, usageDaily: .0642, message: 'OpenRouter account balance', updated: new Date().toISOString() }
};
