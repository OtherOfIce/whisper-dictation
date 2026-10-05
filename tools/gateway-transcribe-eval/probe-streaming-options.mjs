// Experimental wire-level probe. Bypasses SDK option validation and leaves the
// app's production capability settings unchanged.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { readPcmWav, safeError, STREAM_MODEL } from './core.mjs';

const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const audioPath = argument('--audio');
const variant = argument('--variant') ?? 'combined';
const variants = {
  combined: { phraseList: { phrases: ['Hashirama', 'Raikage'] }, transcribeStyle: 'clean' },
  phrases: { phraseList: { phrases: ['Hashirama', 'Raikage'] } },
  style: { transcribeStyle: 'clean' },
  baseline: {}
};

async function main() {
  if (!audioPath || !Object.hasOwn(variants, variant)) throw new Error('Use --audio <wav> and --variant combined|phrases|style|baseline.');
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key) throw new Error('AI_GATEWAY_API_KEY is missing.');
  const dictionaryPath = argument('--dictionary');
  if (dictionaryPath) {
    const phrases = JSON.parse(await readFile(dictionaryPath, 'utf8'));
    if (!Array.isArray(phrases) || !phrases.length || phrases.some(p => typeof p !== 'string' || !p.trim())) {
      throw new Error('Dictionary must be a nonempty JSON array of phrases.');
    }
    if (!['combined', 'phrases'].includes(variant)) throw new Error('--dictionary requires combined or phrases variant.');
    variants[variant].phraseList = { phrases };
  }
  const style = argument('--style');
  if (style) {
    if (!['clean', 'verbatim'].includes(style) || !['combined', 'style'].includes(variant)) {
      throw new Error('--style clean|verbatim requires combined or style variant.');
    }
    variants[variant].transcribeStyle = style;
  }
  const { pcm, rate, seconds } = readPcmWav(await readFile(audioPath));
  const startFrame = { type: 'transcription-stream.start', inputAudioFormat: { type: 'audio/pcm', rate },
    providerOptions: { azure: variants[variant] } };
  const report = { runAt: new Date().toISOString(), variant, model: STREAM_MODEL,
    audioPath: path.resolve(audioPath), audioSeconds: seconds, startFrame,
    events: [], sentPcmBytes: 0, transcript: null, error: null };
  const start = performance.now();
  const signal = AbortSignal.timeout(45000);
  const socket = new WebSocket(`wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=${encodeURIComponent(STREAM_MODEL)}`,
    ['ai-gateway-transcription.v1', `ai-gateway-auth.${key}`]);
  let ended = false, sending;
  try {
    await new Promise((resolve, reject) => {
      const stop = error => {
        if (ended) return;
        ended = true;
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => stop(new Error('Streaming probe timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => {
        socket.send(JSON.stringify(startFrame));
        sending = (async () => {
          const replayStart = performance.now();
          const frameBytes = rate * 2 * 0.04;
          for (let offset = 0; offset < pcm.length && !ended; offset += frameBytes) {
            const wait = replayStart + offset / (rate * 2) * 1000 - performance.now();
            if (wait > 0) await delay(wait, undefined, { signal });
            if (ended) return;
            const frame = pcm.subarray(offset, offset + frameBytes);
            socket.send(frame); report.sentPcmBytes += frame.length;
          }
          const wait = replayStart + seconds * 1000 - performance.now();
          if (wait > 0 && !ended) await delay(wait, undefined, { signal });
          if (!ended) socket.send(JSON.stringify({ type: 'transcription-stream.audio-done' }));
        })();
        sending.catch(stop);
      };
      socket.onmessage = message => {
        try {
          const event = JSON.parse(message.data);
          report.events.push({ ms: performance.now() - start, event });
          if (event.type === 'error') stop(new Error(JSON.stringify(event.error)));
          if (event.type === 'finish') { report.transcript = event.text ?? null; stop(); }
        } catch (error) { stop(error); }
      };
      socket.onerror = () => stop(new Error('Gateway WebSocket connection failed.'));
      socket.onclose = event => stop(new Error(`Gateway closed before finish: ${event.code}`));
    });
  } catch (error) { report.error = safeError(error, key); }
  finally {
    ended = true;
    socket.close();
    if (sending) await sending.catch(() => {});
  }
  report.elapsedMs = performance.now() - start;
  const output = path.resolve(argument('--output') ?? `../../artifacts/gateway-streaming-options-${variant}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  const redact = text => text.replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]');
  await writeFile(output, redact(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ variant, audioSeconds: seconds, sentPcmBytes: report.sentPcmBytes,
    warnings: report.events.filter(e => e.event.type === 'stream-start').flatMap(e => e.event.warnings ?? []),
    transcript: report.transcript, error: report.error, report: output }, null, 2));
  if (report.error) process.exitCode = 1;
}

main().catch(error => { console.error(safeError(error, process.env.AI_GATEWAY_API_KEY ?? '')); process.exitCode = 2; });
