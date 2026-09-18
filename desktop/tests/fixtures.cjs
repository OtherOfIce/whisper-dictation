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
    { name: 'Part 1 · Transcribe audio', startMs: 18524, durationMs: 1231 },
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
  history: texts.map((text, i) => ({ id: `demo-${i}`, text, hasAudio: i === 0, metrics: {
    ...metrics,
    started: new Date(Date.now() - i * 3600000).toISOString(),
    costs: [
      { category: 'voice', model: [
        'microsoft/mai-transcribe-2', 'openai/gpt-transcribe', 'microsoft/mai-transcribe-2', 'microsoft/mai-transcribe-2'
      ][i], amount: [0.0012, 0.001, 0.0011, 0.0009][i] },
      ...([0, 2].includes(i) ? [{ category: 'cleanup', model: 'openai/gpt-5.6-luna', amount: i === 0 ? 0.0003 : 0.0005 }] : [])
    ]
  } })),
  settings: { hasKey: true, liveChunks: false, lockMode: true, transcriptionModel: 'mai-transcribe-2-clean', cleanupMode: 'off', dictionaryTerms: [] },
  balance: {
    kind: 'account', remaining: 18.42, usage: 1.5832, usageDaily: .0642, message: 'OpenRouter account balance', updated: new Date().toISOString()
  },
  costLedger: {
    through: new Date(Date.now() - 86400000).toISOString(), importedAt: new Date().toISOString(),
    rows: [
      { date: '2026-09-14', category: 'voice', model: 'microsoft/mai-transcribe-2', provider: 'Azure', endpoint: 'voice-1', amount: 0.012, requests: 8 },
      { date: '2026-09-14', category: 'voice', model: 'openai/gpt-transcribe', provider: 'OpenAI', endpoint: 'voice-2', amount: 0.005, requests: 3 },
      { date: '2026-09-14', category: 'cleanup', model: 'openai/gpt-5.6-luna', provider: 'OpenAI', endpoint: 'luna-1', amount: 0.003, requests: 4 }
    ]
  },
  activityImport: {
    through: new Date(Date.now() - 86400000).toISOString(), importedAt: new Date().toISOString(),
    rows: [
      { date: '2026-09-14', category: 'voice', model: 'microsoft/mai-transcribe-2', provider: 'Azure', endpoint: 'voice-1', amount: 0.02, requests: 12 },
      { date: '2026-09-14', category: 'cleanup', model: 'openai/gpt-5.6-luna', provider: 'OpenAI', endpoint: 'luna-1', amount: 0.004, requests: 6 }
    ]
  }
};
