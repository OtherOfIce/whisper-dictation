const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.TRANSCRIPT_REVIEWER_PORT || 4177);
const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = process.env.TRANSCRIPT_REVIEWER_CORPUS
  ? path.resolve(process.env.TRANSCRIPT_REVIEWER_CORPUS)
  : path.join(ROOT, 'artifacts', 'wispr-corpus', 'normal');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PUBLIC = path.join(__dirname, 'public');
const INITIAL_REVIEW = path.join(__dirname, 'initial-review-data.json');

function modelLabel(model, style) {
  if (model === 'microsoft/mai-transcribe-2' && style === 'clean') return 'MAI Clean';
  if (model === 'microsoft/mai-transcribe-2' && style === 'verbatim') return 'MAI Verbatim';
  if (model === 'openai/gpt-transcribe') return 'GPT Transcribe';
  return style ? `${model} (${style})` : model;
}

const reports = fs.readdirSync(ARTIFACTS)
  .filter((name) => /^transcribe-eval-normal-.*\.json$/i.test(name))
  .map((name) => {
    const report = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, name), 'utf8'));
    const model = report.Model || name;
    const style = report.Style || '';
    return { file: name, model, style, label: modelLabel(model, style), runAt: report.RunAt || '', results: report.Results || [] };
  });

function samples() {
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8')); }
    catch { return {}; }
  })();
  const sequence = new Map((manifest.samples || []).map((sample, index) => [sample.id, sample.sequence ?? index + 1]));
  return fs.readdirSync(CORPUS)
    .filter((name) => name.endsWith('.transcripts.json'))
    .sort((left, right) => (sequence.get(left.slice(0, -'.transcripts.json'.length)) ?? Number.MAX_SAFE_INTEGER)
      - (sequence.get(right.slice(0, -'.transcripts.json'.length)) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right))
    .map((transcriptName) => {
      const id = transcriptName.slice(0, -'.transcripts.json'.length);
      const readJson = (suffix, fallback) => {
        const file = path.join(CORPUS, `${id}${suffix}`);
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
      };
      const readText = (suffix) => {
        try { return fs.readFileSync(path.join(CORPUS, `${id}${suffix}`), 'utf8'); } catch { return ''; }
      };
      const transcripts = readJson('.transcripts.json', {});
      const dictionary = readJson('.dictionary.json', {});
      const candidate = readJson('.candidate.json', null);
      const reportResults = reports.map((report) => {
        const result = report.results.find((item) => item.Id === id);
        return result ? {
          model: report.model,
          label: report.label,
          style: report.style,
          runAt: report.runAt,
          transcript: result.Transcript || '',
          reference: result.Reference || '',
          wordErrorRate: result.WordErrorRate,
          substitutions: result.Substitutions,
          deletions: result.Deletions,
          insertions: result.Insertions,
          requestMs: result.RequestMs,
          encodeMs: result.EncodeMs,
          audioSeconds: result.AudioSeconds,
          reportedCost: result.ReportedCost,
          estimatedCost: result.EstimatedCost,
          dictionaryTerms: Object.prototype.hasOwnProperty.call(result, 'DictionaryTerms') ? result.DictionaryTerms : null,
          dictionaryTermsPresent: Object.prototype.hasOwnProperty.call(result, 'DictionaryTerms'),
          error: result.Error || null,
        } : { model: report.model, label: report.label, style: report.style, runAt: report.runAt, transcript: '', dictionaryTerms: null, dictionaryTermsPresent: false, error: 'No result in report' };
      });
      return {
        id,
        audioUrl: `/data/audio/${encodeURIComponent(id)}`,
        provisional: readText('.txt').trim(),
        transcripts: {
          selectedReference: transcripts.selectedReference || '',
          asrText: transcripts.asrText || '',
          formattedText: transcripts.formattedText || '',
          editedText: transcripts.editedText || '',
          pastedText: transcripts.pastedText || '',
          serverFinalizedText: transcripts.serverFinalizedText || '',
        },
        dictionary: {
          recordedAt: dictionary.recordedAt || '',
          reconstruction: dictionary.reconstruction || '',
          terms: Array.isArray(dictionary.terms) ? dictionary.terms : [],
        },
        candidate,
        reports: reportResults,
      };
    });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function initialReview() {
  const seeded = JSON.parse(fs.readFileSync(INITIAL_REVIEW, 'utf8'));
  const reviewFile = path.join(CORPUS, 'review.json');
  if (!fs.existsSync(reviewFile)) return seeded;
  const imported = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  return {
    ...seeded,
    reviews: { ...(seeded.reviews || {}), ...(imported.reviews || {}) }
  };
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/data') {
    try { const corpus = samples(); return send(res, 200, JSON.stringify({ localOnly: true, dataset: path.basename(CORPUS), sampleCount: corpus.length, reports: reports.map(({ file, model, label, style, runAt }) => ({ file, model, label, style, runAt })), samples: corpus })); }
    catch (error) { return send(res, 500, JSON.stringify({ error: error.message })); }
  }
  if (url.pathname === '/api/initial-review') {
    try { return send(res, 200, JSON.stringify(initialReview())); }
    catch (error) { return send(res, 500, JSON.stringify({ error: error.message })); }
  }
  if (url.pathname.startsWith('/data/audio/')) {
    const id = safeId(decodeURIComponent(url.pathname.slice('/data/audio/'.length)));
    const file = id && path.join(CORPUS, `${id}.wav`);
    if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const size = fs.statSync(file).size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
          return res.end();
        }
        start = Math.max(0, size - suffixLength);
        end = size - 1;
      } else {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (start >= size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      end = Math.min(end, size - 1);
      status = 206;
    }
    const headers = { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    if (req.method !== 'GET') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  let filePath = url.pathname === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname.slice(1));
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(`${PUBLIC}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Transcript reviewer listening at http://127.0.0.1:${PORT}`);
  console.log('Local only. No external requests are made. Press Ctrl+C to stop.');
});
