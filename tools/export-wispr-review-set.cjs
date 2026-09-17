const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = argument('--database') ?? path.join(process.env.APPDATA, 'Wispr Flow', 'flow.sqlite');
const idsPath = path.resolve(argument('--ids') ?? fail('Pass --ids with a candidate JSON file.'));
const outputPath = path.resolve(argument('--output') ?? fail('Pass --output with an empty destination directory.'));
const limit = positiveInteger(argument('--limit') ?? '10', '--limit');
const overwrite = process.argv.includes('--overwrite');

if (!fs.existsSync(databasePath)) fail(`Wispr database not found: ${databasePath}`);
if (!fs.existsSync(idsPath)) fail(`Candidate file not found: ${idsPath}`);
if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length > 0 && !overwrite)
  fail(`Output folder is not empty: ${outputPath}. Pass --overwrite to refresh this derived review set.`);

const payload = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
if (!Array.isArray(payload.candidates)) fail('Candidate file must contain a candidates array.');
const candidates = payload.candidates.slice(0, limit);
if (!candidates.length || candidates.some(candidate => typeof candidate.id !== 'string' || !candidate.id.trim()))
  fail('Candidate file has no valid candidate IDs.');

fs.mkdirSync(outputPath, { recursive: true });
const database = new DatabaseSync(databasePath, { readOnly: true });
const dictionaryRows = database.prepare(`
  SELECT phrase, replacement, createdAt, isDeleted, isSnippet
  FROM Dictionary ORDER BY createdAt, phrase
`).all();
const select = database.prepare(`
  SELECT transcriptEntityId, timestamp, duration, speechDuration, numWords, status, appVersion,
         audio, asrText, formattedText, editedText, pastedText, serverFinalizedText,
         additionalContext, contentObservationEndReason, numWordsCorrected, editDistanceToDictated
  FROM History WHERE transcriptEntityId = ?
`);

const exported = [];
try {
  for (const [index, candidate] of candidates.entries()) {
    const row = select.get(candidate.id);
    if (!row) fail(`Wispr history row not found: ${candidate.id}`);
    if (!row.audio) fail(`Candidate has no retained audio: ${candidate.id}`);
    const audio = Buffer.from(row.audio);
    if (audio.subarray(0, 4).toString('ascii') !== 'RIFF' || audio.subarray(8, 12).toString('ascii') !== 'WAVE')
      fail(`Candidate audio is not WAV: ${candidate.id}`);

    const id = row.transcriptEntityId;
    const transcripts = {
      selectedReference: chooseReference(row),
      asrText: text(row.asrText),
      formattedText: text(row.formattedText),
      editedText: text(row.editedText),
      pastedText: text(row.pastedText),
      serverFinalizedText: text(row.serverFinalizedText)
    };
    const reference = transcripts[transcripts.selectedReference] ?? '';
    const context = textboxContext(row.additionalContext);
    const dictionary = dictionaryAt(row.timestamp, dictionaryRows);

    fs.writeFileSync(path.join(outputPath, `${id}.wav`), audio);
    fs.writeFileSync(path.join(outputPath, `${id}.txt`), `${reference}\n`, 'utf8');
    writeJson(path.join(outputPath, `${id}.transcripts.json`), transcripts);
    writeJson(path.join(outputPath, `${id}.dictionary.json`), {
      recordedAt: row.timestamp,
      reconstruction: 'Active non-snippet Wispr terms created at or before this recording.',
      terms: dictionary
    });
    writeJson(path.join(outputPath, `${id}.candidate.json`), {
      sourceId: id,
      sequence: index + 1,
      category: candidate.category ?? '',
      rerecordable: candidate.rerecordable === true,
      context,
      evidence: {
        contentObservationEndReason: row.contentObservationEndReason ?? null,
        numWordsCorrected: numberOrNull(row.numWordsCorrected),
        editDistanceToDictated: numberOrNull(row.editDistanceToDictated)
      }
    });
    exported.push({
      id, sequence: index + 1, category: candidate.category ?? '', timestamp: row.timestamp,
      durationSeconds: numberOrNull(row.duration), speechSeconds: numberOrNull(row.speechDuration),
      words: numberOrNull(row.numWords), status: row.status, appVersion: row.appVersion,
      audioBytes: audio.length, selectedReference: transcripts.selectedReference,
      contextCharacters: context.beforeText.length + context.selectedText.length + context.afterText.length
    });
  }
} finally {
  database.close();
}

writeJson(path.join(outputPath, 'manifest.json'), {
  generatedAt: new Date().toISOString(),
  purpose: 'Private review set for Luna cleanup benchmark candidates.',
  sourceDatabase: databasePath,
  warning: 'Contains private audio, transcript stages, dictionary terms, and insertion context. Do not commit or share.',
  samples: exported
});
const equivalencePolicy = path.join(__dirname, 'transcribe-eval', 'equivalence-policy.json');
if (fs.existsSync(equivalencePolicy)) fs.copyFileSync(equivalencePolicy, path.join(outputPath, 'equivalence-policy.json'));
console.log(`Exported ${exported.length} review candidates to ${outputPath}`);

function chooseReference(row) {
  for (const key of ['pastedText', 'formattedText', 'serverFinalizedText', 'asrText'])
    if (text(row[key])) return key;
  return 'asrText';
}

function textboxContext(value) {
  let packet = parseJson(value) ?? {};
  let textbox = packet.textbox_contents ?? {};
  if (typeof textbox === 'string') textbox = parseJson(textbox) ?? {};
  return {
    beforeText: contextText(textbox.beforeText),
    selectedText: contextText(textbox.selectedText),
    afterText: contextText(textbox.afterText),
    isEditable: textbox.isEditable === true,
    accessibilityIsFunctioning: textbox.accessibilityIsFunctioning === true,
    couldNotGetTextBoxInfo: textbox.couldNotGetTextBoxInfo === true
  };
}

function dictionaryAt(timestamp, rows) {
  const recordedAt = new Date(timestamp);
  const terms = [], seen = new Set();
  for (const row of rows) {
    if (new Date(row.createdAt) > recordedAt || row.isDeleted || row.isSnippet) continue;
    const term = text(row.replacement) ?? text(row.phrase);
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); terms.push(term); }
  }
  return terms;
}

function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function contextText(value) { return typeof value === 'string' ? value : ''; }
function numberOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null; }
function positiveInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) fail(`${name} must be a positive integer.`); return number; }
function fail(message) { if (message) console.error(message); process.exit(2); }
