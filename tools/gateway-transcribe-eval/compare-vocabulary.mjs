// One recording, three requests. Reports accuracy only with an explicit reference.
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createGateway } from '@ai-sdk/gateway';
import { STREAM_MODEL, readPcmWav, replayStreaming, transcribeBatch, wordDistance, safeError } from './core.mjs';

const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

async function main() {
  const audioPath = argument('--audio'), dictionaryPath = argument('--dictionary');
  if (!audioPath || !dictionaryPath) throw new Error('Use --audio <wav> --dictionary <JSON array> [--reference <text file>] [--output <folder>].');
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key) throw new Error('AI_GATEWAY_API_KEY is missing.');
  const wav = await readFile(audioPath);
  const { seconds } = readPcmWav(wav);
  const phrases = JSON.parse(await readFile(dictionaryPath, 'utf8'));
  if (!Array.isArray(phrases) || !phrases.length || phrases.some(p => typeof p !== 'string' || !p.trim())) {
    throw new Error('Dictionary must be a nonempty JSON array of phrases.');
  }
  const referencePath = argument('--reference');
  const reference = referencePath ? (await readFile(referencePath, 'utf8')).trim() : null;
  if (referencePath && !reference) throw new Error('Reference is empty.');
  const output = path.resolve(argument('--output') ?? '../../artifacts/gateway-vocabulary-check');
  await mkdir(output, { recursive: true });
  const savedAudio = path.join(output, 'recording.wav');
  if (path.resolve(audioPath) !== savedAudio) await copyFile(audioPath, savedAudio);
  const gateway = createGateway({ apiKey: key });
  const batchOptions = { azure: { transcribeStyle: 'verbatim' } };
  const variants = [
    { name: 'streaming-without-hints', model: STREAM_MODEL, streaming: true },
    { name: 'batch-without-hints', model: 'microsoft/mai-transcribe-2', providerOptions: batchOptions },
    { name: 'batch-with-dictionary', model: 'microsoft/mai-transcribe-2',
      providerOptions: { azure: { ...batchOptions.azure, phraseList: { phrases } } } }
  ];
  const report = { runAt: new Date().toISOString(), audioPath: path.resolve(audioPath),
    audioSha256: createHash('sha256').update(wav).digest('hex'), audioSeconds: seconds,
    dictionarySource: path.resolve(dictionaryPath), phrases, reference,
    notes: ['Single attempt per variant, sequential, no retries.',
      'Streaming replays in real time; batch uploads the complete file. Request times are not directly comparable.',
      'No accuracy score without a confirmed reference.'], results: [] };
  const save = () => writeFile(path.join(output, 'comparison.json'),
    JSON.stringify(report, null, 2).replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]'));
  await save();
  for (const variant of variants) {
    console.log(`Running ${variant.name}...`);
    const signal = AbortSignal.timeout(Math.ceil((seconds + 60) * 1000));
    let result;
    try {
      const value = variant.streaming
        ? await replayStreaming({ model: gateway.transcriptionModel(variant.model), wav, signal })
        : await transcribeBatch({ model: gateway.transcriptionModel(variant.model), wav,
          providerOptions: variant.providerOptions, signal });
      result = { variant: variant.name, model: variant.model, providerOptions: variant.providerOptions,
        ...value, ...(reference ? wordDistance(reference, value.transcript) : {}), error: null };
    } catch (error) {
      result = { variant: variant.name, model: variant.model, error: safeError(error, key) };
      process.exitCode = 1;
    }
    report.results.push(result);
    await save();
    console.log(JSON.stringify({ variant: result.variant, transcript: result.transcript,
      requestMs: result.requestMs, stopToResultMs: result.stopToResultMs,
      warnings: result.warnings, error: result.error }, null, 2));
  }
  console.log(`Report: ${path.join(output, 'comparison.json')}`);
}

main().catch(error => { console.error(safeError(error, process.env.AI_GATEWAY_API_KEY ?? '')); process.exitCode = 2; });
