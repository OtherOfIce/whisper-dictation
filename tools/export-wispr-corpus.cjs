const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const databasePath = argument('--database')
  ?? path.join(process.env.APPDATA, 'Wispr Flow', 'flow.sqlite');
const outputPath = path.resolve(argument('--output') ?? path.join('artifacts', 'wispr-corpus'));
const subsetSize = positiveInteger(argument('--subset-size') ?? '30', '--subset-size');
const suitePath = path.join(__dirname, 'wispr-normal-suite.json');
const equivalencePolicyPath = path.join(__dirname, 'transcribe-eval', 'equivalence-policy.json');

if (!fs.existsSync(databasePath)) fail(`Wispr database not found: ${databasePath}`);
if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length > 0) {
  fail(`Output folder is not empty: ${outputPath}`);
}

const allPath = path.join(outputPath, 'all');
const normalPath = path.join(outputPath, 'normal');
fs.mkdirSync(allPath, { recursive: true });
fs.mkdirSync(normalPath, { recursive: true });

const database = new DatabaseSync(databasePath, { readOnly: true });
let rows, dictionaryRows;
try {
  rows = database.prepare(`
    SELECT transcriptEntityId, timestamp, duration, speechDuration, numWords,
           status, appVersion, audio, asrText, formattedText, editedText,
           pastedText, serverFinalizedText
    FROM History
    WHERE audio IS NOT NULL
    ORDER BY timestamp, transcriptEntityId
  `).all();
  dictionaryRows = database.prepare(`
    SELECT phrase, replacement, createdAt, modifiedAt, isDeleted, isSnippet
    FROM Dictionary
    ORDER BY createdAt, phrase
  `).all();
} finally {
  database.close();
}

const samples = [];
for (const [index, row] of rows.entries()) {
  const audio = Buffer.from(row.audio);
  if (audio.subarray(0, 4).toString('ascii') !== 'RIFF'
      || audio.subarray(8, 12).toString('ascii') !== 'WAVE') {
    fail(`History row ${row.transcriptEntityId} does not contain WAV audio.`);
  }

  const baseName = fileName(row.timestamp, row.transcriptEntityId);
  const wavName = `${baseName}.wav`;
  const reference = chooseReference(row);
  const transcriptName = reference ? `${baseName}.txt` : null;
  const variantsName = `${baseName}.transcripts.json`;
  const dictionaryName = `${baseName}.dictionary.json`;
  const dictionary = dictionaryAt(row.timestamp, dictionaryRows);

  fs.writeFileSync(path.join(allPath, wavName), audio);
  if (reference) fs.writeFileSync(path.join(allPath, transcriptName), `${reference.text}\n`, 'utf8');
  fs.writeFileSync(path.join(allPath, variantsName), `${JSON.stringify({
    selectedReference: reference?.source ?? null,
    asrText: text(row.asrText),
    formattedText: text(row.formattedText),
    editedText: text(row.editedText),
    pastedText: text(row.pastedText),
    serverFinalizedText: text(row.serverFinalizedText)
  }, null, 2)}\n`, 'utf8');
  writeJson(path.join(allPath, dictionaryName), {
    recordedAt: row.timestamp,
    reconstruction: 'Active non-snippet Wispr terms created at or before this recording.',
    terms: dictionary.terms
  });

  samples.push({
    sequence: index + 1,
    id: row.transcriptEntityId,
    timestamp: row.timestamp,
    durationSeconds: number(row.duration),
    speechSeconds: number(row.speechDuration),
    words: number(row.numWords),
    status: row.status,
    appVersion: row.appVersion,
    audioFile: wavName,
    transcriptFile: transcriptName,
    transcriptVariantsFile: variantsName,
    dictionaryFile: dictionaryName,
    dictionaryTerms: dictionary.terms.length,
    referenceSource: reference?.source ?? null,
    audioBytes: audio.length,
    audioSha256: crypto.createHash('sha256').update(audio).digest('hex')
  });
}

const normalCandidates = samples.filter(sample =>
  sample.transcriptFile
  && sample.status === 'formatted'
  && sample.durationSeconds >= 3
  && sample.durationSeconds <= 40
  && sample.words >= 3);
const pinnedIds = readPinnedIds(suitePath);
const normalSamples = pinnedIds
  ? pinnedSampleSet(samples, pinnedIds, subsetSize)
  : quantileSample(normalCandidates, subsetSize);

for (const sample of normalSamples) {
  for (const name of [sample.audioFile, sample.transcriptFile, sample.transcriptVariantsFile, sample.dictionaryFile]) {
    fs.copyFileSync(path.join(allPath, name), path.join(normalPath, name));
  }
}
if (fs.existsSync(equivalencePolicyPath))
  fs.copyFileSync(equivalencePolicyPath, path.join(normalPath, 'equivalence-policy.json'));

const generatedAt = new Date().toISOString();
const referencePriority = ['editedText', 'pastedText', 'formattedText', 'serverFinalizedText', 'asrText'];
writeJson(path.join(outputPath, 'manifest.json'), {
  generatedAt,
  sourceDatabase: databasePath,
  warning: 'Wispr references are edited outputs, not manually verified verbatim ground truth.',
  dictionaryReconstruction: {
    method: 'Include active non-snippet rows whose createdAt is no later than the recording timestamp.',
    exactForThisExport: dictionaryRows.every(row => !row.isDeleted
      && Math.abs(new Date(row.createdAt) - new Date(row.modifiedAt)) < 1000),
    limitation: 'Wispr stores current dictionary rows, not a change log. Later modifications or deletions cannot be reconstructed exactly.'
  },
  referencePriority,
  recordings: samples.length,
  pairedRecordings: samples.filter(sample => sample.transcriptFile).length,
  recordingsWithoutTranscript: samples.filter(sample => !sample.transcriptFile).length,
  totalAudioSeconds: sum(samples, 'durationSeconds'),
  totalAudioBytes: sum(samples, 'audioBytes'),
  samples
});
writeJson(path.join(normalPath, 'manifest.json'), {
  generatedAt,
  sourceManifest: '..\\manifest.json',
  purpose: 'Deterministic everyday-dictation benchmark subset.',
  selection: pinnedIds ? {
    method: 'Pinned reviewed suite plus deliberate replacements.',
    configFile: '..\\..\\..\\tools\\wispr-normal-suite.json',
    requestedSamples: subsetSize
  } : {
      method: 'Duration-quantile sample after metadata-only eligibility filtering.',
      requestedSamples: subsetSize,
      eligibleSamples: normalCandidates.length,
      minimumDurationSeconds: 3,
      maximumDurationSeconds: 40,
      minimumWords: 3,
      requiredStatus: 'formatted'
    },
  equivalencePolicyFile: fs.existsSync(equivalencePolicyPath) ? 'equivalence-policy.json' : null,
  recordings: normalSamples.length,
  totalAudioSeconds: sum(normalSamples, 'durationSeconds'),
  totalAudioBytes: sum(normalSamples, 'audioBytes'),
  samples: normalSamples
});
fs.writeFileSync(path.join(outputPath, 'README.txt'), [
  'Private Wispr Flow benchmark corpus',
  '',
  'all/ contains every retained WAV recording. Paired recordings have a .txt',
  'benchmark reference and a .transcripts.json file containing Wispr text stages.',
  'Each recording also has a .dictionary.json snapshot reconstructed from terms',
  'that existed when that recording was made.',
  '',
  'normal/ contains the deterministic everyday-use subset accepted by the existing',
  'tools/transcribe-eval runner. These files may contain private speech and must not',
  'be committed or shared.',
  ''
].join('\n'), 'utf8');

console.log(`Exported ${samples.length} recordings to ${allPath}`);
console.log(`Paired transcripts: ${samples.filter(sample => sample.transcriptFile).length}; missing transcripts: ${samples.filter(sample => !sample.transcriptFile).length}`);
console.log(`Normal subset: ${normalSamples.length} recordings, ${sum(normalSamples, 'durationSeconds').toFixed(1)} seconds`);
console.log(`Manifest: ${path.join(outputPath, 'manifest.json')}`);

function chooseReference(row) {
  for (const source of ['editedText', 'pastedText', 'formattedText', 'serverFinalizedText', 'asrText']) {
    const value = text(row[source]);
    if (value) return { source, text: value };
  }
  return null;
}

function dictionaryAt(timestamp, rows) {
  const recordedAt = new Date(timestamp);
  if (Number.isNaN(recordedAt.valueOf())) fail(`Invalid Wispr recording timestamp: ${timestamp}`);
  const terms = [];
  const seen = new Set();
  for (const row of rows) {
    const createdAt = new Date(row.createdAt);
    if (Number.isNaN(createdAt.valueOf())) fail(`Invalid Wispr dictionary timestamp: ${row.createdAt}`);
    if (createdAt > recordedAt || row.isDeleted || row.isSnippet) continue;
    const term = text(row.replacement) ?? text(row.phrase);
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); terms.push(term); }
  }
  return { terms };
}

function quantileSample(values, count) {
  if (values.length < count) fail(`Only ${values.length} recordings meet the normal-subset criteria; requested ${count}.`);
  const sorted = [...values].sort((left, right) =>
    left.durationSeconds - right.durationSeconds
    || String(left.timestamp).localeCompare(String(right.timestamp))
    || left.id.localeCompare(right.id));
  if (count === 1) return [sorted[Math.floor(sorted.length / 2)]];
  return Array.from({ length: count }, (_, index) =>
    sorted[Math.round(index * (sorted.length - 1) / (count - 1))]);
}

function readPinnedIds(file) {
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value.sampleIds) || value.sampleIds.some(id => typeof id !== 'string' || !id.trim()))
    fail(`Pinned suite has an invalid sampleIds array: ${file}`);
  const ids = value.sampleIds.map(id => id.trim());
  if (new Set(ids).size !== ids.length) fail(`Pinned suite contains duplicate IDs: ${file}`);
  return ids;
}

function pinnedSampleSet(values, ids, count) {
  if (ids.length !== count)
    fail(`Pinned suite contains ${ids.length} IDs but --subset-size is ${count}.`);
  const byId = new Map(values.map(value => [value.id, value]));
  return ids.map(id => {
    const sample = byId.get(id);
    if (!sample) fail(`Pinned suite sample is absent from the database: ${id}`);
    if (!sample.transcriptFile) fail(`Pinned suite sample has no provisional transcript: ${id}`);
    return sample;
  });
}

function fileName(timestamp, id) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) fail(`Invalid Wispr timestamp for ${id}: ${timestamp}`);
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${id.slice(0, 8)}`;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sum(values, property) {
  return values.reduce((total, value) => total + value[property], 0);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer.`);
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
