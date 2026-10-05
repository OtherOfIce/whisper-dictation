import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGateway } from '@ai-sdk/gateway';
import { STREAM_MODEL, readPcmWav, replayStreaming, transcribeBatch, wordDistance, summarize, safeError } from './core.mjs';

function wav({ rate = 16000, samples = 1600, channels = 1 } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * 2, 8); fmt.writeUInt16LE(channels * 2, 12); fmt.writeUInt16LE(16, 14);
  const chunk = (name, data) => {
    const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('JUNK', Buffer.from('abc')),
    chunk('fmt ', fmt), chunk('data', Buffer.alloc(samples * 2, 1))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function mockGateway(behavior = 'finish') {
  let instance;
  class Socket {
    bufferedAmount = 0;
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.sent = []; instance = this;
      setImmediate(() => this.onopen?.());
    }
    event(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    send(value) {
      this.sent.push(value);
      if (typeof value !== 'string') {
        if (!this.partial) {
          this.partial = true;
          this.event({ type: 'transcript-partial', text: 'wrong provisional text' });
          this.event({ type: 'transcript-partial', text: 'revised provisional text' });
          this.event({ type: 'transcript-delta', delta: 'Hello' });
        }
        return;
      }
      const frame = JSON.parse(value);
      if (frame.type === 'transcription-stream.audio-done') {
        if (behavior === 'close') this.onclose?.({ code: 1000 });
        else if (behavior === 'error') this.event({ type: 'error', error: 'Access denied' });
        else if (behavior !== 'hang') {
          this.event({ type: 'transcript-final', text: 'Hello world.' });
          this.event({ type: 'finish', text: 'Hello world.', segments: [], language: 'en' });
        }
      }
    }
    close() { this.closed = true; this.onclose?.({ code: 1000 }); }
  }
  const gateway = createGateway({ apiKey: 'test-secret', webSocket: Socket });
  return { model: gateway.transcription(STREAM_MODEL), socket: () => instance };
}

test('WAV parsing strips metadata including odd-sized chunks and validates PCM', () => {
  const parsed = readPcmWav(wav());
  assert.equal(parsed.seconds, 0.1);
  assert.equal(parsed.pcm.length, 3200);
  assert.deepEqual(parsed.pcm, Buffer.alloc(3200, 1));
  assert.equal(readPcmWav(wav({ rate: 24000 })).rate, 24000);
  assert.throws(() => readPcmWav(wav({ rate: 48000 })), /Requires PCM/);
  assert.throws(() => readPcmWav(wav({ channels: 2 })), /Requires PCM/);
  assert.throws(() => readPcmWav(wav().subarray(0, 35)), /Truncated/);
});

test('Gateway SDK sends start, raw PCM and done, scores authoritative finish once', async () => {
  const mock = mockGateway();
  const value = await replayStreaming({ model: mock.model, wav: wav(), realtime: false,
    language: 'en', signal: AbortSignal.timeout(2000) });
  assert.equal(value.transcript, 'Hello world.');
  assert.equal(value.events.length, 4);
  assert.ok(value.firstTranscriptMs <= value.firstFinalMs);
  assert.ok(value.stopToResultMs >= 0);
  const socket = mock.socket();
  assert.ok(socket.url.includes('mai-transcribe-2-streaming'));
  assert.deepEqual(socket.protocols, ['ai-gateway-transcription.v1', 'ai-gateway-auth.test-secret']);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'transcription-stream.start',
    inputAudioFormat: { type: 'audio/pcm', rate: 16000 }, providerOptions: { azure: { language: 'en' } } });
  assert.deepEqual(Buffer.concat(socket.sent.filter(v => typeof v !== 'string')), readPcmWav(wav()).pcm);
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'transcription-stream.audio-done');
  assert.ok(socket.closed);
});

test('real-time replay waits for the complete audio duration before Stop', async () => {
  const mock = mockGateway();
  const value = await replayStreaming({ model: mock.model, wav: wav(), realtime: true,
    signal: AbortSignal.timeout(2000) });
  assert.ok(value.audioEndMs >= 90, `Stop ${value.audioEndMs}ms for 100ms audio`);
  assert.ok(value.firstTranscriptMs < value.audioEndMs);
});

test('clean socket close without finish fails rather than using partials', async () => {
  const mock = mockGateway('close');
  await assert.rejects(replayStreaming({ model: mock.model, wav: wav(), realtime: false,
    signal: AbortSignal.timeout(2000) }));
});

test('server errors and timeout aborts fail and close the socket', async () => {
  for (const behavior of ['error', 'hang']) {
    const mock = mockGateway(behavior);
    await assert.rejects(replayStreaming({ model: mock.model, wav: wav(), realtime: false,
      signal: AbortSignal.timeout(100) }));
    assert.ok(mock.socket().closed);
  }
});

test('WER and aggregates count deletions, insertions and failures', () => {
  assert.equal(wordDistance('Hello, WORLD!', 'hello world').wordErrorRate, 0);
  assert.equal(wordDistance('one two three', 'one four').wordErrors, 2);
  assert.equal(wordDistance('one', 'one two').wordErrors, 1);
  const result = summarize([{ ...wordDistance('one two', 'one'), estimatedCostUsd: 0.01,
    firstTranscriptMs: 20, stopToResultMs: 10, requestMs: 100 }, { error: 'failed', estimatedCostUsd: 0.02 }]);
  assert.equal(result.microWordErrorRate, 0.5);
  assert.equal(result.failed, 1);
  assert.equal(result.estimatedCostUsd, 0.03);
  assert.equal(summarize([{ error: 'failed' }]).requestMs.p50, null);
});

test('batch SDK posts a WAV once and never retries failed requests', async () => {
  let calls = 0, requestBody;
  let fail = false;
  const gateway = createGateway({ apiKey: 'test-secret', fetch: async (url, options) => {
    calls++;
    assert.ok(String(url).endsWith('/transcription-model'));
    requestBody = JSON.parse(options.body);
    return fail ? new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 })
      : new Response(JSON.stringify({ text: 'Hello world.', segments: [], language: 'en', warnings: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const value = await transcribeBatch({ model: gateway.transcription('microsoft/mai-transcribe-2'), wav: wav() });
  assert.equal(value.transcript, 'Hello world.');
  assert.equal(requestBody.mediaType, 'audio/wav');
  assert.deepEqual(Buffer.from(requestBody.audio, 'base64'), wav());
  assert.equal(calls, 1);
  fail = true;
  await assert.rejects(transcribeBatch({ model: gateway.transcription('microsoft/mai-transcribe-2'), wav: wav() }));
  assert.equal(calls, 2);
});

test('error messages redact credentials and authentication subprotocols', () => {
  const message = safeError(new Error('secret ai-gateway-auth.secret vcst_abc123'), 'secret');
  assert.ok(!message.includes('secret'));
  assert.ok(!message.includes('vcst_abc123'));
});

test('CLI validates reviewed selection without credentials and refuses invalid arguments', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-transcribe-eval-'));
  try {
    await writeFile(path.join(directory, 'a.wav'), wav());
    await writeFile(path.join(directory, 'a.reviewed.txt'), 'Hello world.');
    await writeFile(path.join(directory, 'b.wav'), wav());
    await writeFile(path.join(directory, 'b.txt'), 'Unreviewed.');
    const env = { ...process.env }; delete env.AI_GATEWAY_API_KEY;
    const invoke = (...args) => spawnSync(process.execPath, ['benchmark.mjs', '--source', directory, ...args],
      { cwd: path.dirname(fileURLToPath(import.meta.url)), env, encoding: 'utf8' });
    const dry = invoke('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /1 samples x 3 repeats/);
    assert.match(dry.stdout, /skipped=1/);
    assert.match(dry.stdout, /No API calls/);
    const missingKey = invoke('--repeats', '1');
    assert.equal(missingKey.status, 2);
    assert.match(missingKey.stderr, /AI_GATEWAY_API_KEY/);
    assert.equal(invoke('--chunk-ms', '0', '--dry-run').status, 2);
    assert.equal(invoke('--unknown', 'x').status, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
