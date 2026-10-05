import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGateway } from '@ai-sdk/gateway';
import { STREAM_MODEL, readPcmWav, replayStreaming, transcribeBatch, wordDistance, summarize, safeError } from './core.mjs';

const help = `Usage: npm run bench -- --source <folder> [options]
  --mode stream|batch       Default stream; batch uses microsoft/mai-transcribe-2
  --replay realtime|burst   Default realtime. Burst is a throughput test.
  --repeats N              Default 3, sequential calls with no retries
  --sample ID              Test one WAV stem
  --max-samples N          Limit corpus size
  --language en            Optional Azure language hint, streaming only
  --chunk-ms N             PCM frame duration, default 40, max 1000
  --timeout-seconds N      Per call, default audio duration + 60 seconds
  --price-per-hour N       Estimate only; default streaming $0.54, batch $0.10
  --output <file.json>     Default ../../artifacts/gateway-transcribe-<mode>.json
  --dry-run                Validate files and show estimated spend, no API calls
  --show-partials          Print provisional and committed text
  --help                   Show this help

Set AI_GATEWAY_API_KEY in the environment or this tool's ignored .env.local.
Pairs are *.wav + *.reviewed.txt when any reviewed reference exists,
otherwise *.wav + *.txt. References and transcripts go into the private report.
WER is case/punctuation insensitive and does not apply equivalence-policy.json.`;

async function main() {
  const options = {};
  const flags = new Set(['help', 'dry-run', 'show-partials']);
  const allowed = new Set(['source', 'mode', 'replay', 'repeats', 'sample', 'max-samples', 'language',
    'chunk-ms', 'timeout-seconds', 'price-per-hour', 'output', ...flags]);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(name)) throw new Error(`Unknown argument: ${args[i]}`);
    if (flags.has(name)) options[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      options[name] = value;
    }
  }
  if (options.help) { console.log(help); return; }
  if (!options.source) throw new Error('--source is required. Use --help for examples.');
  const mode = options.mode ?? 'stream', replay = options.replay ?? 'realtime';
  if (!['stream', 'batch'].includes(mode)) throw new Error('--mode must be stream or batch.');
  if (!['realtime', 'burst'].includes(replay)) throw new Error('--replay must be realtime or burst.');
  if (mode === 'batch' && options.language) throw new Error('--language applies only to streaming.');
  const number = (name, fallback, max = Infinity, integer = true) => {
    const value = options[name] === undefined ? fallback : Number(options[name]);
    if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`Invalid --${name}. Must be positive${integer ? ' integer' : ''}, at most ${max}.`);
    return value;
  };
  const repeats = number('repeats', 3, 100);
  const limit = number('max-samples', Number.MAX_SAFE_INTEGER);
  const chunkMs = number('chunk-ms', 40, 1000);
  const timeoutSeconds = options['timeout-seconds'] ? number('timeout-seconds', 60, Infinity, false) : null;
  const pricePerHour = number('price-per-hour', mode === 'stream' ? 0.54 : 0.10, Infinity, false);
  const source = path.resolve(options.source);
  const modelId = mode === 'stream' ? STREAM_MODEL : 'microsoft/mai-transcribe-2';
  const files = await readdir(source);
  const reviewed = files.some(file => file.endsWith('.reviewed.txt'));
  const samples = [];
  let skippedUnreviewed = 0;
  for (const file of files.filter(file => file.toLowerCase().endsWith('.wav')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const id = file.slice(0, -4);
    if (options.sample && id !== options.sample) continue;
    const referenceFile = `${id}${reviewed ? '.reviewed' : ''}.txt`;
    if (!files.includes(referenceFile)) { skippedUnreviewed++; continue; }
    if (samples.length >= limit) break;
    const wav = await readFile(path.join(source, file));
    const audio = readPcmWav(wav);
    const reference = (await readFile(path.join(source, referenceFile), 'utf8')).trim();
    if (!reference) throw new Error(`Empty reference: ${referenceFile}`);
    samples.push({ id, file, referenceFile, seconds: audio.seconds, rate: audio.rate });
  }
  if (!samples.length) throw new Error('No matching WAV/reference pairs.');
  const audioSeconds = samples.reduce((sum, s) => sum + s.seconds, 0) * repeats;
  console.log(`${modelId}: ${samples.length} samples x ${repeats} repeats, ${audioSeconds.toFixed(1)} audio seconds.`);
  console.log(`References: ${reviewed ? 'reviewed' : 'provisional, may already be edited'}; skipped=${skippedUnreviewed}.`);
  console.log(`Estimated complete-run cost $${(audioSeconds / 3600 * pricePerHour).toFixed(6)} at $${pricePerHour}/hour. No automatic retries.`);
  if (options['dry-run']) { console.log('Dry run complete. No API calls.'); return; }
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key) throw new Error('Set AI_GATEWAY_API_KEY or add it to tools/gateway-transcribe-eval/.env.local.');
  const output = path.resolve(options.output ?? `../../artifacts/gateway-transcribe-${mode}.json`);
  // Check output access before spending money.
  await mkdir(path.dirname(output), { recursive: true });
  await access(path.dirname(output));
  const gateway = createGateway({ apiKey: key });
  const results = [];
  const report = { runAt: new Date().toISOString(), source, model: modelId, mode,
    replay: mode === 'stream' ? replay : null, repeats, chunkMs, language: options.language ?? null,
    pricePerHour, referenceKind: reviewed ? 'reviewed' : 'provisional', skippedUnreviewed,
    scoring: 'NFKC, lowercase, punctuation-insensitive word Levenshtein; no accepted equivalences',
    timing: 'Clock starts before SDK call, includes connection setup. Streaming Stop is when all PCM has been supplied and input closes, not WebSocket wire acknowledgement.',
    cost: 'Duration estimate, not billed usage. Failed requests may still incur charges.', results };
  const save = async () => {
    report.aggregate = summarize(results);
    // Defensive redaction includes the whole serialized report, not just errors.
    const json = JSON.stringify(report, null, 2).replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]');
    const temporary = output + '.tmp';
    await writeFile(temporary, json);
    const { rename } = await import('node:fs/promises');
    await rename(temporary, output);
  };
  const interrupted = new AbortController();
  const stop = () => interrupted.abort(new Error('Benchmark interrupted.'));
  process.once('SIGINT', stop);
  try {
    for (let repeat = 1; repeat <= repeats && !interrupted.signal.aborted; repeat++) {
      // Alternate order to reduce repeat/order bias while keeping calls serial.
      const order = repeat % 2 ? samples : [...samples].reverse();
      for (const sample of order) {
        if (interrupted.signal.aborted) break;
        const start = performance.now();
        const row = { id: sample.id, repeat, audioSeconds: sample.seconds, rate: sample.rate,
          referenceFile: sample.referenceFile, estimatedCostUsd: sample.seconds / 3600 * pricePerHour };
        try {
          const wav = await readFile(path.join(source, sample.file));
          const reference = (await readFile(path.join(source, sample.referenceFile), 'utf8')).trim();
          const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(Math.ceil((timeoutSeconds ?? sample.seconds + 60) * 1000))]);
          let outcome;
          if (mode === 'stream') outcome = await replayStreaming({ model: gateway.transcription(modelId),
            wav, realtime: replay === 'realtime', chunkMs, language: options.language, signal,
            onPart: options['show-partials'] ? part => console.log(`  ${part.ms.toFixed(0)}ms ${part.type}: ${part.text}`) : undefined });
          else outcome = await transcribeBatch({ model: gateway.transcription(modelId), wav, signal });
          Object.assign(row, outcome, { reference, ...wordDistance(reference, outcome.transcript), error: null });
          console.log(`${sample.id} #${repeat}: WER ${(row.wordErrorRate * 100).toFixed(1)}%, first=${row.firstTranscriptMs?.toFixed(0) ?? 'n/a'}ms, stop=${row.stopToResultMs?.toFixed(0) ?? 'n/a'}ms, total=${row.requestMs.toFixed(0)}ms`);
        } catch (error) {
          Object.assign(row, { error: safeError(error, key), elapsedMs: performance.now() - start });
          console.error(`${sample.id} #${repeat}: ${row.error}`);
        }
        results.push(row);
        await save();
      }
    }
  } finally { process.removeListener('SIGINT', stop); }
  console.log(`Report: ${output}`);
  console.log(JSON.stringify(report.aggregate, null, 2));
  if (interrupted.signal.aborted || results.some(row => row.error)) process.exitCode = 1;
}

main().catch(error => { console.error(safeError(error, process.env.AI_GATEWAY_API_KEY ?? '')); process.exitCode = 2; });
