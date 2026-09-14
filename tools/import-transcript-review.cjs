const fs = require('node:fs');
const path = require('node:path');

const reviewPath = path.resolve(argument('--review') ?? fail('Pass --review with the exported review JSON.'));
const corpusPath = path.resolve(argument('--corpus') ?? path.join('artifacts', 'wispr-corpus', 'normal'));
if (!fs.existsSync(reviewPath)) fail(`Review file not found: ${reviewPath}`);
if (!fs.existsSync(corpusPath)) fail(`Corpus folder not found: ${corpusPath}`);

const payload = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
if (payload.format !== 'local-whisper-transcript-review' || payload.version !== 1 || !payload.reviews)
  fail('Unsupported transcript review export.');

const sampleIds = new Set(fs.readdirSync(corpusPath)
  .filter(name => name.endsWith('.wav'))
  .map(name => name.slice(0, -4)));
const imported = { ...payload.reviews };
let written = 0, excluded = 0;

for (const [id, review] of Object.entries(payload.reviews)) {
  if (!sampleIds.has(id)) continue;
  if (!review?.reviewed) continue;
  if (review.excluded) { excluded++; continue; }
  const canonical = typeof review.canonical === 'string' ? review.canonical.trim() : '';
  if (!canonical) fail(`Reviewed sample has no canonical transcript: ${id}`);
  fs.writeFileSync(path.join(corpusPath, `${id}.reviewed.txt`), `${canonical}\n`, 'utf8');
  written++;
}

const missing = [...sampleIds].filter(id => !imported[id]?.reviewed || imported[id]?.excluded);
const outOfSuite = Object.keys(imported).filter(id => !sampleIds.has(id));
const result = {
  format: payload.format,
  version: payload.version,
  importedAt: new Date().toISOString(),
  sourceExportedAt: payload.exportedAt ?? null,
  reviews: imported,
  summary: {
    samples: sampleIds.size,
    reviewedReferences: written,
    excludedInSuite: excluded,
    unreviewed: missing.length,
    unreviewedIds: missing,
    outOfSuiteReviews: outOfSuite.length,
    outOfSuiteIds: outOfSuite
  }
};
fs.writeFileSync(path.join(corpusPath, 'review.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`Imported ${written} reviewed references; excluded ${excluded}; unreviewed ${missing.length}.`);
if (missing.length) console.log(`Unreviewed: ${missing.join(', ')}`);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function fail(message) {
  if (message) console.error(message);
  process.exit(2);
}
