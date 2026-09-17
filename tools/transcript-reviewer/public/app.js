(() => {
  'use strict';
  const STORAGE_KEY = 'local-whisper-transcript-review:v2';
  const state = { data: null, index: 0, search: '', filter: 'all', reviews: loadReviews(), seedStatus: '' };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '');

  function loadReviews() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  function reviewFor(id) {
    return state.reviews[id] || { canonical: '', comment: '', verdict: '', reviewed: false, excluded: false, exclusionReason: '', equivalenceNotes: '' };
  }
  function saveReviews() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.reviews));
    $('saveStatus').textContent = 'Saved locally';
    window.setTimeout(() => { if ($('saveStatus')) $('saveStatus').textContent = ''; }, 1600);
    renderProgress();
    renderList();
  }
  function currentSample() { return filteredSamples()[state.index] || null; }
  function selectInitialSample() {
    const requested = new URLSearchParams(window.location.search).get('sample');
    if (!requested) return;
    const index = filteredSamples().findIndex((sample) => sample.id === requested);
    if (index >= 0) state.index = index;
  }
  function filteredSamples() {
    if (!state.data) return [];
    const query = state.search.trim().toLowerCase();
    return state.data.samples.filter((sample) => {
      const review = reviewFor(sample.id);
      const statusOk = state.filter === 'all' || (state.filter === 'reviewed' && review.reviewed) || (state.filter === 'unreviewed' && !review.reviewed) || (state.filter === 'excluded' && review.excluded);
      if (!statusOk) return false;
      if (!query) return true;
      const haystack = [sample.id, sample.provisional, ...Object.values(sample.transcripts), ...sample.reports.map((r) => r.transcript)].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }
  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function formatMs(value) { return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : '—'; }
  function formatRate(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}% WER` : '—'; }
  function renderProgress() {
    const samples = state.data?.samples || [];
    const reviewed = samples.filter((s) => reviewFor(s.id).reviewed).length;
    $('progressLabel').textContent = `${reviewed} of ${samples.length} reviewed`;
    $('progressPercent').textContent = samples.length ? `${Math.round(reviewed / samples.length * 100)}%` : '';
    $('progressBar').style.width = samples.length ? `${reviewed / samples.length * 100}%` : '0%';
  }
  function renderList() {
    const list = $('sampleList');
    list.replaceChildren();
    const samples = filteredSamples();
    samples.forEach((sample, i) => {
      const review = reviewFor(sample.id);
      const button = create('button', `sample-item${sample === currentSample() ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-current', sample === currentSample() ? 'true' : 'false');
      button.addEventListener('click', () => { state.index = i; render(); });
      const stateMark = review.excluded ? 'Excluded' : review.reviewed ? (review.verdict || 'Reviewed') : 'Unreviewed';
      button.append(create('span', 'sample-id', sample.id));
      button.append(create('span', `sample-status status-${review.reviewed ? 'reviewed' : 'open'}`, stateMark));
      list.append(button);
    });
    if (!samples.length) list.append(create('p', 'muted list-empty', 'No matching samples.'));
  }
  function renderStages(sample) {
    const container = $('transcriptStages');
    container.replaceChildren();
    const labels = { asrText: 'ASR', formattedText: 'Formatted', editedText: 'Edited', pastedText: 'Pasted', serverFinalizedText: 'Server final' };
    Object.entries(labels).forEach(([key, label]) => {
      const text = sample.transcripts[key];
      if (!text) return;
      const row = create('div', 'stage-row');
      row.append(create('span', 'stage-label', label));
      row.append(create('p', 'readout stage-text', text));
      container.append(row);
    });
    if (!container.children.length) container.append(create('p', 'muted', 'No transcript stages available.'));
  }
  function renderCandidate(sample) {
    const panel = $('candidatePanel');
    const candidate = sample.candidate;
    panel.hidden = !candidate;
    if (!candidate) return;
    $('candidateCategory').textContent = candidate.category || 'Uncategorised';
    $('contextBefore').textContent = candidate.context?.beforeText || 'No preceding text captured.';
    $('contextSelected').textContent = candidate.context?.selectedText || 'No selection captured.';
    $('contextAfter').textContent = candidate.context?.afterText || 'No following text captured.';
    const evidence = candidate.evidence || {};
    $('candidateEvidence').textContent = [
      candidate.rerecordable ? 'Suitable for a recreated recording' : 'Keep as original-audio test',
      evidence.numWordsCorrected == null ? null : `${evidence.numWordsCorrected} corrected words recorded`,
      evidence.contentObservationEndReason ? `observation ended: ${evidence.contentObservationEndReason}` : null,
    ].filter(Boolean).join(' · ');
  }
  function renderModels(sample) {
    const container = $('modelOutputs');
    container.replaceChildren();
    sample.reports.forEach((report) => {
      const card = create('section', 'model-output');
      const title = create('div', 'model-title');
      title.append(create('strong', '', report.label || report.model));
      if (report.style) title.append(create('span', 'tag', report.style));
      card.append(title);
      card.append(create('p', report.error ? 'readout error-text' : 'readout', report.error || report.transcript || 'No transcript'));
      const metrics = create('div', 'metrics');
      [['WER', formatRate(report.wordErrorRate)], ['Errors', `${report.substitutions ?? 0} S / ${report.deletions ?? 0} D / ${report.insertions ?? 0} I`], ['Request', formatMs(report.requestMs)], ['Encode', formatMs(report.encodeMs)], ['Audio', Number.isFinite(Number(report.audioSeconds)) ? `${Number(report.audioSeconds).toFixed(1)} s` : '—']].forEach(([label, value]) => {
        const metric = create('span', 'metric');
        metric.append(create('b', '', label));
        metric.append(document.createTextNode(` ${value}`));
        metrics.append(metric);
      });
      card.append(metrics);
      const reportNote = create('p', 'model-note');
      reportNote.textContent = report.dictionaryTermsPresent ? `Historical dictionary recorded${Array.isArray(report.dictionaryTerms) ? `: ${report.dictionaryTerms.length} terms` : ''}` : `Saved run ${report.runAt || 'date unavailable'} · no historical dictionary recorded in this report`;
      card.append(reportNote);
      container.append(card);
    });
    $('modelCount').textContent = `${sample.reports.length} reports`;
  }
  function renderReviewFields(sample) {
    const review = reviewFor(sample.id);
    const initial = review.canonical || sample.transcripts[sample.transcripts.selectedReference] || sample.transcripts.editedText || sample.provisional;
    $('canonicalText').value = initial;
    $('comment').value = review.comment || '';
    $('equivalenceNotes').value = review.equivalenceNotes || '';
    $('verdict').value = review.verdict || '';
    $('reviewed').checked = Boolean(review.reviewed);
    $('excluded').checked = Boolean(review.excluded);
    $('exclusionReason').value = review.exclusionReason || '';
    $('exclusionReason').disabled = !review.excluded;
  }
  function render() {
    const samples = filteredSamples();
    if (state.index >= samples.length) state.index = Math.max(0, samples.length - 1);
    renderList();
    renderProgress();
    const sample = samples[state.index];
    $('emptyState').hidden = Boolean(sample);
    $('reviewContent').hidden = !sample;
    if (!sample) return;
    $('samplePosition').textContent = `Sample ${state.index + 1} of ${samples.length} shown`;
    $('sampleTitle').textContent = sample.id;
    $('audioPlayer').src = sample.audioUrl;
    $('audioMeta').textContent = 'WAV recording';
    $('provisionalText').textContent = sample.provisional || 'No provisional text found.';
    $('referenceKind').textContent = sample.transcripts.selectedReference ? `Selected: ${sample.transcripts.selectedReference}` : 'Reference stage unavailable';
    renderStages(sample);
    renderCandidate(sample);
    renderModels(sample);
    $('dictionaryCount').textContent = `${sample.dictionary.terms.length} terms`;
    $('dictionaryMeta').textContent = [sample.dictionary.recordedAt, sample.dictionary.reconstruction].filter(Boolean).join(' · ') || 'No dictionary reconstruction found.';
    $('dictionaryTerms').replaceChildren(...sample.dictionary.terms.map((term) => create('span', 'term', term)));
    renderReviewFields(sample);
    $('previousButton').disabled = state.index <= 0;
    $('nextButton').disabled = state.index >= samples.length - 1;
  }
  function updateReview(field, value) {
    const sample = currentSample();
    if (!sample) return;
    const review = reviewFor(sample.id);
    if (field !== 'canonical' && !Object.prototype.hasOwnProperty.call(review, 'canonical')) review.canonical = $('canonicalText').value;
    if (field !== 'canonical' && !review.canonical) review.canonical = $('canonicalText').value;
    review[field] = value;
    state.reviews[sample.id] = review;
    saveReviews();
  }
  function move(delta) {
    const samples = filteredSamples();
    state.index = Math.min(Math.max(state.index + delta, 0), Math.max(0, samples.length - 1));
    render();
    $('sampleTitle')?.focus?.();
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportData() {
    const payload = { format: 'local-whisper-transcript-review', version: 1, exportedAt: new Date().toISOString(), corpus: state.data?.dataset || 'unknown', reviews: state.reviews };
    return payload;
  }
  function markdown() {
    const samples = state.data.samples;
    const reviewed = samples.filter((s) => reviewFor(s.id).reviewed);
    const lines = ['# Transcript review', '', `Progress: ${reviewed.length}/${samples.length} reviewed`, '', 'Local review data only.'];
    samples.forEach((sample) => {
      const review = reviewFor(sample.id);
      if (!review.reviewed && !review.comment && !review.verdict && !review.excluded) return;
      lines.push('', `## ${sample.id}`, `- Status: ${review.excluded ? 'excluded' : review.reviewed ? 'reviewed' : 'open'}`);
      if (review.verdict) lines.push(`- Verdict: ${review.verdict}`);
      if (review.excluded && review.exclusionReason) lines.push(`- Exclusion reason: ${review.exclusionReason}`);
      if (review.canonical) lines.push('', 'Canonical transcript:', '', '```text', review.canonical, '```');
      if (review.comment) lines.push('', `Comment: ${review.comment}`);
      if (review.equivalenceNotes) lines.push('', `Accepted equivalence: ${review.equivalenceNotes}`);
    });
    return `${lines.join('\n')}\n`;
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        const incoming = payload.reviews && typeof payload.reviews === 'object' ? payload.reviews : payload;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Expected a review export with a reviews object.');
        Object.entries(incoming).forEach(([id, review]) => { if (state.data.samples.some((sample) => sample.id === id) && review && typeof review === 'object') state.reviews[id] = { ...reviewFor(id), ...review }; });
        saveReviews(); render();
        $('datasetStatus').textContent = 'Imported review data and saved locally.';
      } catch (error) { $('datasetStatus').textContent = `Import failed: ${error.message}`; }
    };
    reader.readAsText(file);
  }
  function installModelContext() {
    if (!('modelContext' in document) || !document.modelContext) return;
    try {
      const mc = document.modelContext;
      if (typeof mc.registerTool !== 'function') return;
      const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
      const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
      mc.registerTool({
        name: 'getReviewProgress',
        title: 'Get transcript review progress',
        description: 'Read the number of reviewed transcript samples and the total corpus size.',
        inputSchema,
        annotations,
        execute: async () => ({ reviewed: (state.data?.samples || []).filter((s) => reviewFor(s.id).reviewed).length, total: state.data?.samples.length || 0 }),
      });
      mc.registerTool({
        name: 'exportCurrentReview',
        title: 'Export current transcript review',
        description: 'Read the current sample ID and its locally saved review fields.',
        inputSchema,
        annotations,
        execute: async () => { const sample = currentSample(); return sample ? { sampleId: sample.id, review: reviewFor(sample.id) } : null; },
      });
    } catch { /* Experimental API. The normal UI must continue if registration changes. */ }
  }
  function bind() {
    $('searchInput').addEventListener('input', (event) => { state.search = event.target.value; state.index = 0; render(); });
    $('statusFilter').addEventListener('change', (event) => { state.filter = event.target.value; state.index = 0; render(); });
    $('previousButton').addEventListener('click', () => move(-1));
    $('nextButton').addEventListener('click', () => move(1));
    $('canonicalText').addEventListener('input', (e) => updateReview('canonical', e.target.value));
    $('comment').addEventListener('input', (e) => updateReview('comment', e.target.value));
    $('equivalenceNotes').addEventListener('input', (e) => updateReview('equivalenceNotes', e.target.value));
    $('verdict').addEventListener('change', (e) => updateReview('verdict', e.target.value));
    $('reviewed').addEventListener('change', (e) => updateReview('reviewed', e.target.checked));
    $('excluded').addEventListener('change', (e) => { $('exclusionReason').disabled = !e.target.checked; updateReview('excluded', e.target.checked); });
    $('exclusionReason').addEventListener('input', (e) => updateReview('exclusionReason', e.target.value));
    $('importButton').addEventListener('click', () => $('importInput').click());
    $('importInput').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
    $('exportJsonButton').addEventListener('click', () => download('transcript-review.json', JSON.stringify(exportData(), null, 2), 'application/json'));
    $('exportMarkdownButton').addEventListener('click', () => download('transcript-review.md', markdown(), 'text/markdown'));
    document.addEventListener('keydown', (event) => { if (event.target.matches('textarea,input,select')) return; if (event.key === 'ArrowLeft') move(-1); if (event.key === 'ArrowRight') move(1); });
  }
  async function init() {
    bind();
    try {
      const [response, seedResponse] = await Promise.all([
        fetch('/api/data', { cache: 'no-store' }),
        fetch('/api/initial-review', { cache: 'no-store' }),
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!seedResponse.ok) throw new Error(`Initial review data HTTP ${seedResponse.status}`);
      state.data = await response.json();
      const seedPayload = await seedResponse.json();
      const seedReviews = seedPayload.reviews && typeof seedPayload.reviews === 'object' ? seedPayload.reviews : {};
      const seededIds = [];
      Object.entries(seedReviews).forEach(([id, review]) => {
        if (!state.data.samples.some((sample) => sample.id === id) || Object.prototype.hasOwnProperty.call(state.reviews, id) || !review || typeof review !== 'object') return;
        state.reviews[id] = { ...reviewFor(id), ...review };
        seededIds.push(id);
      });
      if (seededIds.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(state.reviews));
      state.seedStatus = seededIds.length ? `${seededIds.length} initial feedback entries loaded` : 'Initial feedback checked; existing local reviews kept';
      $('seedStatus').textContent = state.seedStatus;
      $('datasetStatus').textContent = `${state.data.sampleCount} samples loaded from ${state.data.dataset} · ${state.seedStatus}. No network requests are used.`;
      installModelContext();
      selectInitialSample();
      render();
    } catch (error) {
      $('datasetStatus').textContent = `Could not load corpus: ${error.message}`;
      $('emptyState').hidden = false;
      $('emptyState').querySelector('h2').textContent = 'Corpus unavailable';
      $('emptyState').querySelector('p').textContent = 'Start this tool from the repository checkout with node server.cjs.';
    }
  }
  init();
})();
