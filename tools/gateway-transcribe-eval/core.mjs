import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { experimental_streamTranscribe as streamTranscribe, experimental_transcribe as transcribe } from 'ai';

export const STREAM_MODEL = 'microsoft/mai-transcribe-2-streaming';

// Walk RIFF chunks rather than assuming a 44-byte WAV header.
export function readPcmWav(wav) {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a RIFF WAV file.');
  const end = wav.readUInt32LE(4) + 8;
  if (end > wav.length) throw new Error('Truncated RIFF WAV.');
  let format;
  const chunks = [];
  for (let offset = 12; offset + 8 <= end;) {
    const name = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) throw new Error('Truncated WAV chunk.');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format chunk.');
      format = { encoding: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4), byteRate: wav.readUInt32LE(start + 8),
        alignment: wav.readUInt16LE(start + 12), bits: wav.readUInt16LE(start + 14) };
    }
    if (name === 'data') chunks.push(wav.subarray(start, start + size));
    offset = start + size + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16
      || ![16000, 24000].includes(format.rate) || format.alignment !== 2
      || format.byteRate !== format.rate * 2) {
    throw new Error('Requires PCM signed 16-bit mono WAV at 16000 or 24000 Hz. Convert with ffmpeg first.');
  }
  const pcm = Buffer.concat(chunks);
  if (!pcm.length || pcm.length % 2) throw new Error('WAV has empty or incomplete PCM samples.');
  return { pcm, rate: format.rate, seconds: pcm.length / format.byteRate };
}

export function wordDistance(reference, transcript) {
  const words = text => text.normalize('NFKC').toLowerCase().replaceAll('\u2019', "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
  const a = words(reference), b = words(transcript);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(
      previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = current;
  }
  const errors = previous[b.length];
  return { referenceWords: a.length, wordErrors: errors,
    wordErrorRate: a.length ? errors / a.length : (b.length ? 1 : 0) };
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

export function summarize(results) {
  const ok = results.filter(r => !r.error);
  const words = ok.reduce((sum, r) => sum + r.referenceWords, 0);
  const errors = ok.reduce((sum, r) => sum + r.wordErrors, 0);
  const timing = field => ({ p50: percentile(ok.map(r => r[field]), 0.5),
    p95: percentile(ok.map(r => r[field]), 0.95) });
  return { attempts: results.length, successful: ok.length, failed: results.length - ok.length,
    referenceWords: words, wordErrors: errors, microWordErrorRate: words ? errors / words : null,
    firstTranscriptMs: timing('firstTranscriptMs'), stopToResultMs: timing('stopToResultMs'),
    requestMs: timing('requestMs'), estimatedCostUsd: results.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0) };
}

export function safeError(error, key = '') {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (key) message = message.replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]');
  return message.replace(/ai-gateway-auth\.[^\s,;"']+/g, 'ai-gateway-auth.[redacted]')
    .replace(/vcst_[\w-]+/g, '[redacted]').slice(0, 600);
}

export async function transcribeBatch({ model, wav, signal, providerOptions }) {
  const start = performance.now();
  const value = await transcribe({ model, audio: wav, abortSignal: signal, maxRetries: 0, providerOptions });
  if (!value.text.trim()) throw new Error('Gateway returned an empty transcript.');
  return { transcript: value.text, requestMs: performance.now() - start,
    firstTranscriptMs: null, stopToResultMs: null, events: [], language: value.language,
    warnings: value.warnings };
}

export async function replayStreaming({ model, wav, realtime = true, chunkMs = 40,
  language, signal, onPart = () => {} }) {
  if (!Number.isInteger(chunkMs) || chunkMs < 1 || chunkMs > 1000) throw new Error('chunkMs must be 1 to 1000.');
  const { pcm, rate, seconds } = readPcmWav(wav);
  const frameBytes = Math.round(rate * chunkMs / 1000) * 2;
  const start = performance.now();
  let replayStart, audioEndMs = null, suppliedBytes = 0;
  const events = [];
  let firstTranscriptMs = null, firstFinalMs = null, cancelled = false;
  const audio = new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      signal?.throwIfAborted();
      replayStart ??= performance.now();
      if (suppliedBytes === pcm.length) {
        if (realtime) {
          const wait = replayStart + seconds * 1000 - performance.now();
          if (wait > 0) await delay(wait, undefined, { signal });
        }
        if (cancelled) return;
        audioEndMs = performance.now() - start;
        controller.close();
        return;
      }
      if (realtime) {
        const wait = replayStart + suppliedBytes / (rate * 2) * 1000 - performance.now();
        if (wait > 0) await delay(wait, undefined, { signal });
      }
      if (cancelled) return;
      const frame = pcm.subarray(suppliedBytes, suppliedBytes + frameBytes);
      suppliedBytes += frame.length;
      controller.enqueue(frame);
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const result = streamTranscribe({ model, audio, inputAudioFormat: { type: 'audio/pcm', rate },
    providerOptions: language ? { azure: { language } } : undefined, abortSignal: signal });
  // Consume once, before reading result promises. The SDK supplies authoritative
  // finish text; provisional partials must never be concatenated into it.
  for await (const part of result.fullStream) {
    signal?.throwIfAborted();
    if (part.type === 'error') throw part.error;
    const text = part.type === 'transcript-delta' ? part.delta : part.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    const ms = performance.now() - start;
    firstTranscriptMs ??= ms;
    if (part.type === 'transcript-final') firstFinalMs ??= ms;
    const event = { type: part.type, ms, text };
    events.push(event);
    onPart(event);
  }
  const transcript = await result.text;
  if (suppliedBytes !== pcm.length || audioEndMs === null) throw new Error('Server finished before all audio was supplied.');
  if (!transcript.trim()) throw new Error('Gateway returned an empty transcript.');
  const requestMs = performance.now() - start;
  return { transcript, audioSeconds: seconds, audioBytes: pcm.length, rate,
    firstTranscriptMs, firstFinalMs, audioEndMs, requestMs,
    stopToResultMs: requestMs - audioEndMs, events, language: await result.language,
    warnings: await result.warnings };
}
