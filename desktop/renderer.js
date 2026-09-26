const icons = {
  wave: '<path d="M3 10v4m4-8v12m5-15v18m5-13v8m4-11v14"/>',
  history: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 2h6v4H9zM8 11h8m-8 4h5"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2V5l-3-1-2 1z"/><circle cx="11.5" cy="10.5" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 5V3H3v14h2"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14m8-14v14"/>',
  chart: '<path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-6"/>',
  trash: '<path d="M4 6h16M9 3h6m-9 3 1 15h10l1-15M10 10v7m4-7v7"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2m-6 8v4m-3 0h6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  minus: '<path d="M4 12h16"/>', square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  compare: '<path d="M4 6h6v12H4zM14 6h6v12h-6zM10 9h4m-4 6h4"/>'
};
function icon(name) { const span = document.createElement('span'); span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.wave}</svg>`; return span; }
document.querySelectorAll('[data-icon]').forEach(node => node.replaceWith(icon(node.dataset.icon)));
const $ = id => document.getElementById(id);
const call = (method, params) => window.whisper.call(method, params);
let history = [], selectedId = null, comparisonId = null, currentSettings = {}, pageSize = 100, toastTimer, latestBalance;
let activeAudio = null, activeAudioId = null, activeAudioButton = null, activeAudioUrl = null;
function renderWordStats(stats) {
  if (!stats) return;
  $('words-total').textContent = Number(stats.total || 0).toLocaleString();
  $('words-today').textContent = Number(stats.today || 0).toLocaleString();
  $('words-week').textContent = Number(stats.last7Days || 0).toLocaleString();
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function navigate(view) {
  if (view !== 'history') stopAudio();
  $('history-view').hidden = view !== 'history'; $('settings-view').hidden = view !== 'settings';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === view));
  closeDrawers();
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => navigate(button.dataset.view));
document.querySelectorAll('[data-window]').forEach(button => button.onclick = () => call(button.dataset.window).catch(error => toast(error.message)));
function action(name, title, handler) {
  const button = document.createElement('button'); button.title = title; button.setAttribute('aria-label', title); button.append(icon(name)); button.onclick = handler; return button;
}
function setActionIcon(button, name) { button.replaceChildren(icon(name)); }
function stopAudio() {
  activeAudio?.pause();
  if (activeAudioButton) setActionIcon(activeAudioButton, 'play');
  if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
  activeAudio = null; activeAudioId = null; activeAudioButton = null; activeAudioUrl = null;
}
async function toggleAudio(entry, button) {
  if (activeAudioId === entry.id) { stopAudio(); return; }
  stopAudio(); button.disabled = true;
  try {
    const recording = await call('audio', { id: entry.id });
    const bytes = recording.bytes instanceof Uint8Array ? recording.bytes : new Uint8Array(recording.bytes);
    activeAudioUrl = URL.createObjectURL(new Blob([bytes], { type: `audio/${recording.format || 'wav'}` }));
    activeAudio = new Audio(activeAudioUrl); activeAudioId = entry.id; activeAudioButton = button;
    activeAudio.onended = stopAudio; activeAudio.onerror = () => { stopAudio(); toast('Could not play this recording.'); };
    setActionIcon(button, 'pause'); await activeAudio.play();
  } catch (error) { stopAudio(); toast(error.message); }
  finally { button.disabled = false; }
}
function renderHistory() {
  const query = $('search').value.toLocaleLowerCase();
  const filtered = history.filter(entry => entry.text.toLocaleLowerCase().includes(query));
  $('history-count').textContent = `${history.length.toLocaleString()} transcript${history.length === 1 ? '' : 's'}`;
  const fragment = document.createDocumentFragment();
  let day, group;
  for (const entry of filtered.slice(0, pageSize)) {
    const date = new Date(entry.metrics.started);
    const label = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    if (day !== label) {
      day = label; const heading = document.createElement('div'); heading.className = 'day-label'; heading.textContent = label; fragment.append(heading);
      group = document.createElement('div'); group.className = 'transcript-group'; fragment.append(group);
    }
    const article = document.createElement('article'); article.className = 'transcript'; article.dataset.id = entry.id;
    const time = document.createElement('time'); time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const text = document.createElement('div'); text.className = 'transcript-text'; text.textContent = entry.text || entry.metrics.outcome;
    if (!entry.text) text.classList.add('empty');
    const details = transcriptMetaFacts(entry.metrics);
    let meta = null;
    if (details.length) {
      meta = document.createElement('div'); meta.className = 'transcript-meta';
      const wrap = document.createElement('span'); wrap.className = 'meta-details';
      const infoButton = document.createElement('button'); infoButton.type = 'button'; infoButton.className = 'meta-info';
      infoButton.title = 'Show transcription details'; infoButton.setAttribute('aria-label', 'Show transcription details');
      infoButton.append(icon('info'));
      const popover = document.createElement('span'); popover.className = 'meta-popover'; popover.setAttribute('role', 'tooltip');
      for (const [name, value] of details) {
        const row = document.createElement('span'); row.className = 'meta-popover-row';
        const label = document.createElement('span'); label.textContent = name;
        const val = document.createElement('strong'); val.textContent = value;
        row.append(label, val); popover.append(row);
      }
      wrap.append(infoButton, popover); meta.append(wrap);
    }
    const actions = document.createElement('div'); actions.className = 'transcript-actions';
    const play = action('play', entry.hasAudio ? 'Play audio' : 'No saved audio', () => toggleAudio(entry, play));
    const download = action('download', entry.hasAudio ? 'Download audio' : 'No saved audio', () => call('downloadAudio', { id: entry.id }).then(saved => { if (saved) toast('Recording downloaded'); }).catch(error => toast(error.message)));
    play.disabled = download.disabled = !entry.hasAudio;
    const copy = action('copy', 'Copy transcript', () => call('copy', { id: entry.id }).then(() => toast('Transcript copied')).catch(error => toast(error.message)));
    copy.disabled = !entry.text;
    const compare = action('compare', entry.hasAudio ? 'Compare transcripts' : 'No saved audio to compare', () => openComparison(entry.id));
    compare.disabled = !entry.hasAudio;
    actions.append(play, download, compare, copy);
    if (!entry.text && entry.hasAudio) {
      const retry = action('refresh', 'Retry transcription', async () => {
        retry.disabled = true;
        try { await call('retranscribe', { id: entry.id }); toast('Transcript recovered'); }
        catch (error) { toast(error.message); }
        finally { retry.disabled = false; }
      });
      actions.append(retry);
    }
    actions.append(action('chart', 'Show performance', () => openPerformance(entry.id)), action('trash', 'Delete transcript', async () => {
      if (activeAudioId === entry.id) stopAudio();
      try { await call('delete', { id: entry.id }); toast('Transcript deleted'); } catch (error) { toast(error.message); }
    }));
    article.append(time, text, ...(meta ? [meta] : []), actions); group.append(article);
  }
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const symbol = document.createElement('div'); symbol.className = 'empty-icon'; symbol.append(icon(query ? 'search' : 'wave'));
    const title = document.createElement('h2'); title.textContent = query ? 'No matching words.' : 'Start with a thought.';
    const help = document.createElement('p'); help.textContent = query ? 'Try a different word or clear your search.' : 'Hold Ctrl + Win, say what’s on your mind, and release.\nYour transcript will appear here.';
    empty.append(symbol, title, help); fragment.append(empty);
  }
  $('history-list').replaceChildren(fragment); $('load-more').hidden = filtered.length <= pageSize;
}
$('search').oninput = () => { pageSize = 100; renderHistory(); };
$('load-more').onclick = () => { pageSize += 100; renderHistory(); };
const money = (number, digits = 2) => number == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
const modelNames = {
  'openai/gpt-transcribe': 'GPT-Transcribe',
  'microsoft/mai-transcribe-2': 'MAI-Transcribe-2',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'openai/gpt-5.6-luna': 'Luna 5.6',
  'openai/gpt-6-luna': 'Luna 6',
  'gpt-transcribe': 'GPT-Transcribe',
  'mai-transcribe-2-verbatim': 'MAI-Transcribe-2 · Verbatim',
  'mai-transcribe-2-clean': 'MAI-Transcribe-2 · Clean',
  'gemini-3.8-flash': 'Gemini 3.8 Flash · Priority',
  'grok-voice-transcribe-2.0': 'Grok Voice Transcribe 2.0',
  'grok-voice-transcribe-2-streaming': 'Grok Voice Transcribe 2.0 · Streaming',
  luna: 'Luna 6',
  'luna-fast': 'Luna 6 Fast'
};
// Per-entry pipeline provenance. Entries recorded before model tracking have
// no fields and yield no facts, so old history renders unchanged.
function pipelineFacts(metrics) {
  const facts = [];
  const model = typeof metrics?.transcriptionModel === 'string' && metrics.transcriptionModel
    ? (modelNames[metrics.transcriptionModel] || metrics.transcriptionModel) : '';
  if (!model) return facts;
  const requested = typeof metrics?.requestedTranscriptionModel === 'string' && metrics.requestedTranscriptionModel
    ? (modelNames[metrics.requestedTranscriptionModel] || metrics.requestedTranscriptionModel) : '';
  facts.push(['Voice model', requested && requested !== model ? `${requested} → ${model}` : model]);
  const cleanup = metrics.cleanupMode;
  facts.push(['Cleanup', !cleanup || cleanup === 'off' ? 'Off' : (modelNames[cleanup] || cleanup)]);
  return facts;
}
// Details shown behind the history info icon: pipeline provenance plus the
// timing facts that explain how long a transcript took to come back.
function transcriptMetaFacts(metrics) {
  const facts = pipelineFacts(metrics);
  if (!facts.length) return facts;
  const stop = Number(metrics?.stopMs);
  const paste = Number(metrics?.pasteMs);
  const elapsed = Number(metrics?.elapsedMs);
  let response = '';
  if (Number.isFinite(stop) && Number.isFinite(paste)) response = formatDuration(paste - stop);
  else if (Number.isFinite(stop) && Number.isFinite(elapsed)) response = formatDuration(elapsed - stop);
  else if (Number.isFinite(elapsed)) response = formatDuration(elapsed);
  if (response) facts.push(['Response', response]);
  const audio = Number(metrics?.audioSeconds);
  if (Number.isFinite(audio)) facts.push(['Audio', `${audio.toFixed(1)} s`]);
  return facts;
}
function renderCosts(costs) {
  const activity = costs?.source === 'activity';
  const locallyRecorded = (costs?.voiceCount || 0) + (costs?.cleanupCount || 0) > 0;
  $('cost-voice').textContent = activity ? money(costs.voice, 4) : '—';
  $('cost-cleanup').textContent = activity ? money(costs.cleanup, 4) : '—';
  const popover = $('cost-model-breakdown');
  const fragment = document.createDocumentFragment();
  if (!activity) {
    const heading = document.createElement('span'); heading.className = 'cost-popover-heading'; heading.textContent = 'Complete breakdown unavailable'; fragment.append(heading);
    const help = document.createElement('span'); help.textContent = 'Import OpenRouter activity in Settings to fill the local cost ledger.'; fragment.append(help);
    if (locallyRecorded) {
      const note = document.createElement('span'); note.className = 'cost-popover-note'; note.textContent = `${money(costs.voice + costs.cleanup, 5)} has been recorded locally, but this is only part of the total.`; fragment.append(note);
    }
    popover.replaceChildren(fragment); return;
  }
  for (const category of ['voice', 'cleanup']) {
    const rows = costs.models.filter(item => item.category === category);
    if (!rows.length) continue;
    const heading = document.createElement('span'); heading.className = 'cost-popover-heading'; heading.textContent = category === 'voice' ? 'Voice' : 'Luna'; fragment.append(heading);
    for (const row of rows) {
      const item = document.createElement('span'); item.className = 'cost-popover-row';
      const name = document.createElement('span'); name.textContent = modelNames[row.model] || row.model;
      const amount = document.createElement('strong'); amount.textContent = money(row.amount, 5);
      item.append(name, amount); fragment.append(item);
    }
  }
  const note = document.createElement('span'); note.className = 'cost-popover-note';
  note.textContent = "The last imported 30 completed days, plus costs recorded here today. Direct xAI estimates are always included in full.";
  fragment.append(note);
  popover.replaceChildren(fragment);
}
function renderBalance(balance) {
  latestBalance = balance;
  if (!balance) return;
  const hasBalance = balance.remaining != null;
  $('balance-label').textContent = balance.kind === 'account' ? 'Remaining credit' : balance.kind === 'key' ? 'Key allowance remaining' : 'Used by this API key';
  $('balance-amount').textContent = money(hasBalance ? balance.remaining : balance.usage);
  $('balance-detail').textContent = balance.message;
  $('usage-total').textContent = money(balance.usage, 4); $('usage-today').textContent = money(balance.usageDaily, 4);
  $('balance-updated').textContent = `Updated ${new Date(balance.updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
$('refresh-balance').onclick = async () => {
  $('refresh-balance').disabled = true;
  try { const value = await call('refreshCredits'); if (value?.error) toast(value.error); else if (value) renderBalance(value); }
  catch (error) { toast(error.message); }
  finally { $('refresh-balance').disabled = false; }
};
function renderSettings(settings) {
  currentSettings = settings;
  $('key-status').textContent = settings.hasKey ? 'Saved securely' : 'Not connected';
  $('xai-key-status').textContent = settings.hasXaiKey ? 'Saved securely' : 'Not connected';
  $('live-chunks').checked = !!settings.liveChunks;
  $('double-transcription').checked = !!settings.doubleTranscription;
  $('lock-mode').checked = settings.lockMode !== false;
  $('transcription-model').value = settings.transcriptionModel || 'mai-transcribe-2-clean';
  $('cleanup-mode').value = settings.cleanupMode || 'off';
  $('dictionary-terms').value = Array.isArray(settings.dictionaryTerms) ? settings.dictionaryTerms.join('\n') : '';
  updateModelSettings();
}
function updateModelSettings() {
  const streaming = $('transcription-model').value === 'grok-voice-transcribe-2-streaming';
  const mai = $('transcription-model').value.startsWith('mai-transcribe-2-');
  $('live-chunks-note').textContent = streaming
    ? 'Grok streams microphone audio continuously, so this separate pause-chunk option does not apply.'
    : 'Experimental. Chunks may change punctuation or lose context. Cancel stops pending work; it cannot undo audio already uploaded.';
  $('live-chunks').disabled = streaming;
  $('double-transcription').disabled = !mai;
  $('cleanup-mode').disabled = false;
  $('cleanup-note').textContent = 'Adds a separate OpenRouter request before pasting. To fit the insertion, Luna also receives up to 500 nearby characters from the focused text field; password fields are excluded. Fast uses priority processing at twice the token price. If cleanup fails, the original transcript is used.';
}
$('transcription-model').onchange = updateModelSettings;
$('lock-mode').onchange = async () => {
  const checkbox = $('lock-mode'); const nextValue = checkbox.checked; checkbox.disabled = true;
  try {
    const settings = await call('setLockMode', { lockMode: nextValue });
    renderSettings(settings); $('save-message').textContent = 'Lock mode updated';
  } catch (error) {
    checkbox.checked = !nextValue; toast(error.message);
  } finally { checkbox.disabled = false; }
};
$('import-wispr').onclick = async () => {
  const button = $('import-wispr'); button.disabled = true; $('import-wispr-status').textContent = '';
  try {
    const dictionaryTerms = $('dictionary-terms').value.split(/\r?\n/).map(term => term.trim()).filter(Boolean);
    const result = await call('importWisprDictionary', { dictionaryTerms });
    $('dictionary-terms').value = result.settings.dictionaryTerms.join('\n');
    const skipped = result.skippedSnippets ? ` ${result.skippedSnippets} snippets were skipped.` : '';
    $('import-wispr-status').textContent = `${result.added} new term${result.added === 1 ? '' : 's'} imported.${skipped}`;
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
$('import-costs').onclick = async () => {
  const button = $('import-costs'); const field = $('management-key'); const managementKey = field.value.trim();
  field.value = ''; $('import-costs-status').textContent = ''; button.disabled = true;
  try {
    const result = await call('importOpenRouterActivity', { managementKey });
    renderCosts(result.costs);
    $('import-costs-status').textContent = `${result.rows} cost row${result.rows === 1 ? '' : 's'} imported. Delete the temporary key from OpenRouter.`;
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('settings-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const dictionaryTerms = $('dictionary-terms').value.split(/\r?\n/).map(term => term.trim()).filter(Boolean);
    const settings = await call('saveSettings', { apiKey: $('api-key').value, xaiApiKey: $('xai-api-key').value, liveChunks: $('live-chunks').checked, doubleTranscription: $('double-transcription').checked, lockMode: $('lock-mode').checked, transcriptionModel: $('transcription-model').value, cleanupMode: $('cleanup-mode').value, dictionaryTerms });
    $('api-key').value = ''; $('xai-api-key').value = '';
    renderSettings(settings); $('save-message').textContent = 'Settings saved';
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
async function openPerformance(id) {
  closeComparison();
  selectedId = id; $('include-recording').checked = false;
  const entry = history.find(item => item.id === id);
  $('original-transcript').hidden = typeof entry?.rawText !== 'string' || entry.rawText === entry.text;
  $('original-transcript').open = false;
  $('original-text').textContent = entry?.rawText || '';
  $('performance-drawer').hidden = false; $('drawer-backdrop').hidden = false;
  await renderPerformance(); $('close-drawer').focus();
}
function closePerformance() { selectedId = null; $('performance-drawer').hidden = true; if ($('comparison-drawer').hidden) $('drawer-backdrop').hidden = true; }
function closeComparison() { comparisonId = null; $('comparison-drawer').hidden = true; if ($('performance-drawer').hidden) $('drawer-backdrop').hidden = true; }
function closeDrawers() { closePerformance(); closeComparison(); }
$('close-drawer').onclick = closePerformance; $('close-comparison').onclick = closeComparison; $('drawer-backdrop').onclick = closeDrawers;
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawers(); });
$('include-recording').onchange = renderPerformance;
$('export-timings').onclick = () => call('exportTimings', { id: selectedId }).catch(error => toast(error.message));
function formatDuration(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`; }
async function renderPerformance() {  const id = selectedId;
  if (!id) return;
  try {
    const result = await call('timings', { id, includeRecording: $('include-recording').checked });
    if (id !== selectedId || !result) return;
    const { metrics, chart } = result;
    $('latency-value').textContent = metrics.pasteMs != null && metrics.stopMs != null ? `${((metrics.pasteMs - metrics.stopMs) / 1000).toFixed(2)} s` : 'Not pasted';
    $('latency-caption').textContent = metrics.pasteMs != null ? 'From finishing your recording to sending the paste shortcut.' : metrics.outcome;
    const fragment = document.createDocumentFragment();
    for (const row of chart.rows) {
      const element = document.createElement('div'); element.className = 'timing-row' + (row.name.includes('Transcribe audio') || row.name.includes('Wait for response') ? ' wait' : ''); element.dataset.stage = row.name;
      const label = document.createElement('div'); label.className = 'timing-name'; label.title = row.name; label.textContent = row.name.replace('Part 1 · ', '');
      const track = document.createElement('div'); track.className = 'timing-track';
      const bar = document.createElement('div'); bar.className = 'timing-bar'; const duration = Math.max(1, chart.duration);
      bar.style.left = `${Math.max(0, row.start / duration * 100)}%`; bar.style.width = `${Math.min(100, row.duration / duration * 100)}%`; track.append(bar);
      const value = document.createElement('div'); value.className = 'timing-value'; value.textContent = row.duration >= 1000 ? `${(row.duration / 1000).toFixed(2)} s` : `${Math.round(row.duration)} ms`;
      element.append(label, track, value); fragment.append(element);
    }
    $('timings').replaceChildren(fragment);
    $('timing-note').textContent = $('include-recording').checked ? 'Full session, including time spent speaking and clipboard cleanup.' : `Recording time and clipboard cleanup are excluded.${chart.completedEarly ? ` ${chart.completedEarly} stages finished before Stop.` : ''}`;
    const facts = [['Audio length', `${metrics.audioSeconds.toFixed(1)} s`], ['Request size', `${(metrics.requestBytes / 1024).toFixed(0)} KB`], ['Longest UI gap', `${metrics.maxUiGapMs.toFixed(0)} ms`]];
    facts.unshift(...pipelineFacts(metrics));
    for (const hedge of metrics.hedges ?? []) {
      facts.push(['Hedge fired', `after ${formatDuration(hedge.cutoffMs)}`]);
      if (hedge.savedMs != null) facts.push(['Hedge saved', `≈ ${formatDuration(hedge.savedMs)} — attempt ${hedge.winnerAttempt} answered in ${formatDuration(hedge.winnerMs)}, the other took ${formatDuration(hedge.loserMs)}`]);
      else facts.push(['Hedge winner', `attempt ${hedge.winnerAttempt} answered in ${formatDuration(hedge.winnerMs)} — the other ran ${formatDuration(hedge.loserMs ?? hedge.cutoffMs)} with no response`]);
    }
    for (const request of metrics.parallelRequests ?? [])
      facts.push([`Request ${request.attempt}${request.selected ? ' · used' : ''}`, `${modelNames[request.model] || request.model} · ${formatDuration(request.durationMs)} · ${request.outcome}`]);
    if (!(metrics.parallelRequests?.length))
      for (const [index, request] of (metrics.requests ?? []).entries())
        facts.push([`Request ${index + 1}`, `${modelNames[request.model] || request.model} · ${formatDuration(request.durationMs)} · ${request.outcome}`]);
    for (const fallback of metrics.fallbacks ?? []) facts.push(['Fallback from', `${modelNames[fallback.model] || fallback.model}: ${fallback.error}`]);
    $('timing-facts').replaceChildren(...facts.map(([name, text]) => { const item = document.createElement('div'); item.textContent = name; const value = document.createElement('strong'); value.textContent = text; item.append(value); return item; }));
  } catch (error) { toast(error.message); }
}
function versionButton(label, actionName, handler) {
  const button = document.createElement('button'); button.className = 'secondary-button'; button.textContent = label;
  button.dataset.action = actionName; button.onclick = handler; return button;
}
function renderComparison() {
  const entry = history.find(item => item.id === comparisonId);
  if (!entry) { closeComparison(); return; }
  const versions = [{ id: null, text: entry.text, metrics: entry.metrics, primary: true }, ...(entry.alternatives || [])];
  const fragment = document.createDocumentFragment();
  for (const version of versions) {
    const card = document.createElement('article'); card.className = 'transcript-version';
    if (version.id) card.dataset.alternateId = version.id;
    const header = document.createElement('div'); header.className = 'version-header';
    const name = document.createElement('strong'); name.textContent = pipelineFacts(version.metrics)[0]?.[1] || 'Unknown model';
    const badge = document.createElement('span'); badge.textContent = version.primary ? 'Primary' : 'Alternate'; header.append(name, badge);
    const body = document.createElement('p'); body.className = 'transcript-text'; body.textContent = version.text;
    const actions = document.createElement('div'); actions.className = 'version-actions';
    actions.append(versionButton('Copy', 'copy', () => call('copyTranscriptVersion', { id: entry.id, alternateId: version.id }).then(() => toast('Transcript copied')).catch(error => toast(error.message))));
    if (!version.primary) actions.append(versionButton('Make primary', 'make-primary', async () => {
      try { await call('makeTranscriptPrimary', { id: entry.id, alternateId: version.id }); toast('Primary transcript changed'); }
      catch (error) { toast(error.message); }
    }));
    card.append(header, body, actions); fragment.append(card);
  }
  $('comparison-versions').replaceChildren(fragment);
  const primaryModel = entry.metrics?.transcriptionModel;
  const dictionary = Array.isArray(currentSettings.dictionaryTerms) ? currentSettings.dictionaryTerms : [];
  const grokDictionaryCompatible = dictionary.length <= 100 && dictionary.every(term => term.length <= 50);
  for (const option of $('alternate-model').options) {
    const grok = option.value === 'grok-voice-transcribe-2-streaming';
    option.disabled = option.value === primaryModel || (grok ? !currentSettings.hasXaiKey || !grokDictionaryCompatible : !currentSettings.hasKey);
  }
  if ($('alternate-model').selectedOptions[0]?.disabled) $('alternate-model').value = [...$('alternate-model').options].find(option => !option.disabled)?.value || '';
  $('create-alternate').disabled = !$('alternate-model').value;
}
function openComparison(id) {
  closePerformance(); comparisonId = id; $('comparison-drawer').hidden = false; $('drawer-backdrop').hidden = false;
  renderComparison(); $('close-comparison').focus();
}
$('create-alternate').onclick = async () => {
  const button = $('create-alternate'); const id = comparisonId; const model = $('alternate-model').value;
  if (!id || !model) return;
  button.disabled = true; button.textContent = 'Transcribing…';
  try { await call('transcribeAlternate', { id, model }); renderComparison(); toast('Alternate transcript added'); }
  catch (error) { toast(error.message); }
  finally { button.textContent = 'Transcribe'; if (comparisonId) renderComparison(); }
};
window.whisper.onEvent(event => {
  if (event.type === 'transcript') { history.unshift(event.entry); renderHistory(); }
  if (event.type === 'history') { history = event.history; renderHistory(); if (selectedId && !history.some(entry => entry.id === selectedId)) closePerformance(); if (comparisonId) renderComparison(); }
  if (event.type === 'metricsUpdated') { const entry = history.find(x => x.id === event.id); if (entry) entry.metrics = event.metrics; if (event.id === selectedId) renderPerformance(); }
  if (event.type === 'stats') { renderWordStats(event.stats); renderCosts(event.costs); }
  if (event.type === 'balance') renderBalance(event.balance);
  if (event.type === 'balanceError') { $('balance-detail').textContent = latestBalance ? 'Refresh failed. Showing the last known balance.' : 'Balance unavailable. Try refreshing.'; }
  if (event.type === 'settings' || event.type === 'ready') renderSettings(event.settings);
  if (event.type === 'ready') { document.querySelector('.engine-dot').classList.add('connected'); document.querySelector('.engine-dot').title = 'Ready to dictate'; }
  if (event.type === 'engineOffline') { document.querySelector('.engine-dot').classList.remove('connected'); document.querySelector('.engine-dot').title = 'Engine offline. Restart the app.'; }
  if (event.type === 'navigate') navigate(event.view);
  if (event.type === 'notice') toast(event.message);
});
call('initial').then(initial => {
  history = initial.history; renderHistory(); renderWordStats(initial.stats); renderCosts(initial.costs); renderSettings(initial.settings); renderBalance(initial.balance);
  if (initial.historyError) toast('Saved history could not be read. The existing file has been left untouched.');
}).catch(error => toast(error.message));
