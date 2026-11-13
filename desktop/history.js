// History list, the Home page summary, and the transcript drawers.
let pageSize = 100, selectedId = null, comparisonId = null;
const pendingDeletes = new Set();
let activeAudio = null, activeAudioId = null, activeAudioButton = null, activeAudioUrl = null;

function action(name, title, handler, className = 'icon-button') {
  const button = el('button', className); button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
  button.append(icon(name)); button.onclick = handler; return button;
}
function stopAudio() {
  activeAudio?.pause();
  if (activeAudioButton && activeAudioButton.getAttribute('aria-label') !== 'More actions') activeAudioButton.replaceChildren(icon('play'));
  if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
  activeAudio = activeAudioId = activeAudioButton = activeAudioUrl = null;
}
async function toggleAudio(entry, button) {
  if (activeAudioId === entry.id) { stopAudio(); return; }
  stopAudio(); button.disabled = true;
  try {
    const recording = await call('audio', { id: entry.id });
    const bytes = recording.bytes instanceof Uint8Array ? recording.bytes : new Uint8Array(recording.bytes);
    activeAudioUrl = URL.createObjectURL(new Blob([bytes], { type: recording.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
    activeAudio = new Audio(activeAudioUrl); activeAudioId = entry.id; activeAudioButton = button;
    activeAudio.onended = stopAudio; activeAudio.onerror = () => { stopAudio(); toast('Could not play this recording.'); };
    if (button.getAttribute('aria-label') !== 'More actions') button.replaceChildren(icon('pause'));
    await activeAudio.play(); toast('Playing recording', { action: { label: 'Stop', run: stopAudio } });
  } catch (error) { stopAudio(); fail(error); } finally { button.disabled = false; }
}

const visibleHistory = () => app.history.filter(entry => !pendingDeletes.has(entry.id));
// Deleting hides the transcript at once and only removes it for good when the Undo toast expires.
function deleteEntry(entry) {
  if (activeAudioId === entry.id) stopAudio();
  pendingDeletes.add(entry.id); renderAll();
  toast('Transcript deleted', {
    action: { label: 'Undo', run: () => { pendingDeletes.delete(entry.id); renderAll(); } },
    onTimeout: () => call('delete', { id: entry.id }).catch(error => { pendingDeletes.delete(entry.id); renderAll(); fail(error); })
  });
}
async function retry(entry, button) {
  button.disabled = true; button.textContent = 'Retrying…';
  try { await call('retranscribe', { id: entry.id }); toast('Transcript recovered'); }
  catch (error) { fail(error); button.disabled = false; button.replaceChildren(icon('refresh'), ' Retry'); }
}

// The ⋯ menu on each transcript.
let openMenu = null;
function closeRowMenu() { openMenu?.menu.remove(); openMenu?.button.setAttribute('aria-expanded', 'false'); openMenu = null; }
function openRowMenu(entry, button) {
  const wasOpen = openMenu?.button === button; closeRowMenu(); if (wasOpen) return;
  const menu = el('div', 'menu'); menu.setAttribute('role', 'menu');
  const item = (name, label, handler, { disabled = false, danger = false } = {}) => {
    const option = el('button', danger ? 'danger' : ''); option.type = 'button'; option.setAttribute('role', 'menuitem');
    option.append(icon(name), disabled && name !== 'trash' && name !== 'chart' ? `${label} (no saved recording)` : label); option.disabled = disabled; option.onclick = () => { closeRowMenu(); handler(); }; menu.append(option);
  };
  const audio = entry.hasAudio;
  item(activeAudioId === entry.id ? 'pause' : 'play', activeAudioId === entry.id ? 'Stop playing' : 'Play recording', () => toggleAudio(entry, button), { disabled: !audio });
  item('compare', 'Compare with another model', () => openComparison(entry.id), { disabled: !audio });
  item('download', 'Save recording…', () => call('downloadAudio', { id: entry.id }).then(saved => saved && toast('Recording saved')).catch(fail), { disabled: !audio });
  item('chart', 'Timing details', () => openPerformance(entry.id));
  menu.append(el('hr'));
  item('trash', 'Delete', () => deleteEntry(entry), { danger: true });
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  button.setAttribute('aria-expanded', 'true'); openMenu = { menu, button };
  menu.querySelector('button:not(:disabled)')?.focus();
}
document.addEventListener('mousedown', event => { if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.button.contains(event.target)) closeRowMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && openMenu) { event.stopImmediatePropagation(); openMenu.button.focus(); closeRowMenu(); } }, true);
document.querySelector('main').addEventListener('scroll', closeRowMenu);

function highlight(node, text, query) {
  if (!query) { node.textContent = text; return; }
  const lower = text.toLocaleLowerCase(); let index = 0;
  for (let found = lower.indexOf(query); found !== -1; found = lower.indexOf(query, index)) {
    node.append(text.slice(index, found), el('mark', '', text.slice(found, found + query.length)));
    index = found + query.length;
  }
  node.append(text.slice(index));
}
function transcriptRow(entry, query = '') {
  const row = el('article', 'transcript'); row.dataset.id = entry.id;
  const date = new Date(entry.metrics.started);
  const time = el('time', '', date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })); time.dateTime = date.toISOString();
  const body = el('div');
  const text = el('div', 'transcript-text');
  if (entry.text) highlight(text, entry.text, query);
  else { row.classList.add('failed'); text.textContent = entry.metrics.outcome && entry.metrics.outcome !== 'Pasted' ? `Not transcribed · ${entry.metrics.outcome}` : 'Not transcribed'; }
  body.append(text);
  const facts = pipelineFacts(entry.metrics), response = responseTime(entry.metrics);
  if (facts.length) body.append(el('div', 'transcript-meta', [facts[0][1], response != null && entry.text ? formatDuration(response) : ''].filter(Boolean).join(' · ')));
  const actions = el('div', 'transcript-actions');
  if (!entry.text && entry.hasAudio) {
    const button = el('button', 'secondary-button retry-button'); button.type = 'button'; button.append(icon('refresh'), ' Retry');
    button.onclick = () => retry(entry, button); actions.append(button);
  }
  const copy = action('copy', 'Copy transcript', () => call('copy', { id: entry.id }).then(() => toast('Copied')).catch(fail));
  copy.disabled = !entry.text;
  const more = action('dots', 'More actions', () => openRowMenu(entry, more));
  more.setAttribute('aria-haspopup', 'menu');
  actions.append(copy, more);
  row.append(time, body, actions);
  return row;
}
function groupedRows(entries, query) {
  const fragment = document.createDocumentFragment(); let day;
  for (const entry of entries) {
    const label = dayLabel(new Date(entry.metrics.started));
    if (label !== day) { day = label; fragment.append(el('div', 'day-label', label)); }
    fragment.append(transcriptRow(entry, query));
  }
  return fragment;
}
function emptyState(title, message, iconName = 'wave') {
  const box = el('div', 'empty-state'); const symbol = el('div', 'empty-icon'); symbol.append(icon(iconName));
  box.append(symbol, el('h2', '', title), message); return box;
}
function startHint() {
  const help = el('p');
  help.append(lockMode() ? 'Press ' : 'Hold ', ...keycaps(app.settings.shortcut).flatMap((key, index) => index ? [' + ', key] : [key]),
    lockMode() ? ', say what’s on your mind, then press it again. Your words are pasted where you were typing and saved here.' : ', say what’s on your mind, and let go. Your words are pasted where you were typing and saved here.');
  return help;
}

let searchTimer;
function renderHistory() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const all = visibleHistory();
  const filtered = query ? all.filter(entry => entry.text.toLocaleLowerCase().includes(query)) : all;
  $('history-count').textContent = query ? `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()} transcripts` : `${all.length.toLocaleString()} transcript${all.length === 1 ? '' : 's'}, saved on this device`;
  const list = $('history-list');
  $('history-view').querySelector('.empty-state')?.remove();
  if (!filtered.length) {
    list.replaceChildren();
    list.insertAdjacentElement('afterend', query ? emptyState('No matches.', el('p', '', 'Try a different word or clear the search.'), 'search') : emptyState('Start with a thought.', startHint()));
  } else list.replaceChildren(groupedRows(filtered.slice(0, pageSize), query));
  $('load-more').hidden = filtered.length <= pageSize;
}
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { pageSize = 100; renderHistory(); }, 120); };
$('load-more').onclick = () => { pageSize += 100; renderHistory(); };

// --- Home ---
const countWords = value => typeof value === 'string' && value.trim() ? (value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length || 0) : 0;
const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
function insights(history, now = new Date()) {
  let words = 0, today = 0, timedWords = 0, seconds = 0; const days = new Set();
  for (const entry of history) {
    const count = countWords(typeof entry.rawText === 'string' ? entry.rawText : entry.text);
    const date = new Date(entry.metrics?.started);
    words += count;
    if (count && !Number.isNaN(date.getTime())) { days.add(dayKey(date)); if (dayKey(date) === dayKey(now)) today += count; }
    const audio = Number(entry.metrics?.audioSeconds);
    if (count && audio >= 2) { timedWords += count; seconds += audio; }
  }
  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  const wpm = seconds > 30 ? Math.round(timedWords / (seconds / 60)) : null;
  // Typing at about 40 words a minute, minus the time spent speaking.
  const savedMinutes = Math.max(0, words / 40 - seconds / 60);
  return { words, today, wpm, savedMinutes, streak, activeDays: days.size };
}
function formatMinutes(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60); return `${hours} hr ${Math.round(minutes - hours * 60)} min`;
}
function renderHome() {
  const hour = new Date().getHours();
  $('greeting').textContent = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const stats = insights(visibleHistory());
  $('stat-words').textContent = compact(stats.words);
  $('stat-wpm').textContent = stats.wpm ?? '—';
  $('stat-saved').textContent = formatMinutes(stats.savedMinutes);
  $('stat-streak').textContent = stats.streak;
  $('stat-streak-label').textContent = stats.streak === 1 ? 'day streak' : 'day streak';
  $('stat-today').textContent = `${stats.today.toLocaleString()} word${stats.today === 1 ? '' : 's'}`;
  $('home-subtitle').textContent = stats.words ? `You’ve dictated on ${stats.activeDays} day${stats.activeDays === 1 ? '' : 's'}. Speak, don’t type.` : 'Speak, don’t type.';
  $('shortcut-keys').replaceChildren(...keycaps(app.settings.shortcut));
  $('shortcut-tip').textContent = shortcutSentence();
  const recent = visibleHistory().slice(0, 5);
  const list = $('recent-list');
  $('home-view').querySelector('.empty-state')?.remove();
  if (recent.length) list.replaceChildren(groupedRows(recent, ''));
  else { list.replaceChildren(); list.insertAdjacentElement('afterend', emptyState('Start with a thought.', startHint())); }
  const needsKey = missingKey();
  $('setup-card').hidden = !app.engineOnline || !needsKey;
  if (needsKey) $('setup-card').querySelector('p').textContent = `Add ${needsKey === 'openrouter' || needsKey === 'xai' ? 'an' : 'a'} ${credentialNames[needsKey]} API key so Local Whisper can turn your voice into text. Keys stay encrypted on this device.`;
  document.querySelector('.balance-card:not(#gateway-cost-card)').hidden = app.settings.hasKey === false;
}
function renderAll() { renderHistory(); renderHome(); if (comparisonId) renderComparison(); }

// --- Balance ---
let latestBalance, latestGatewayBalance;
function renderBalance(balance) {
  latestBalance = balance;
  if (!balance) return;
  const hasBalance = balance.remaining != null;
  $('balance-label').textContent = balance.kind === 'account' ? 'Remaining credit' : balance.kind === 'key' ? 'Key allowance remaining' : 'Used by this key';
  $('balance-amount').textContent = money(hasBalance ? balance.remaining : balance.usage);
  $('usage-total').textContent = money(balance.usage, 2); $('usage-today').textContent = money(balance.usageDaily, 2);
  $('balance-detail').textContent = balance.updated ? `Updated ${new Date(balance.updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '';
}
function renderGatewayBalance(balance) {
  latestGatewayBalance = balance;
  $('gateway-balance-amount').textContent = money(balance?.remaining);
  $('gateway-usage-total').textContent = money(balance?.usage, 2);
  $('gateway-balance-detail').textContent = balance?.message || '';
}
function renderCosts(costs) {
  if (costs?.models) {
    const models = costs.models.filter(row => !['microsoft/mai-transcribe-2-streaming', 'mai-transcribe-2-streaming'].includes(row.model));
    costs = { ...costs, models, voice: models.filter(row => row.category === 'voice').reduce((total, row) => total + row.amount, 0) };
  }
  const activity = costs?.source === 'activity';
  const small = amount => money(amount, amount > 0 && amount < 1 ? 3 : 2);
  $('cost-voice').textContent = activity ? small(costs.voice) : '—';
  $('cost-cleanup').textContent = activity ? small(costs.cleanup) : '—';
  const items = [];
  if (!activity) {
    items.push(el('span', 'popover-heading', 'Cost split unavailable'), el('span', '', 'Import OpenRouter activity in Settings → API keys to see what voice and cleanup cost.'));
  } else {
    for (const category of ['voice', 'cleanup']) {
      const rows = costs.models.filter(item => item.category === category);
      if (!rows.length) continue;
      items.push(el('span', 'popover-heading', category === 'voice' ? 'Voice' : 'Cleanup'));
      for (const row of rows) { const item = el('span', 'popover-row'); item.append(el('span', '', modelNames[row.model] || row.model), el('strong', '', money(row.amount, 4))); items.push(item); }
    }
    items.push(el('span', '', 'The last imported 30 days, plus today.'));
  }
  $('cost-model-breakdown').replaceChildren(...items);
}
for (const [id, method, render, latest] of [['refresh-balance', 'refreshCredits', renderBalance], ['refresh-gateway-balance', 'refreshGatewayCredits', renderGatewayBalance]]) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    try { const value = await call(method); if (value?.error) toast(value.error); else if (value) render(value); } catch (error) { fail(error); } finally { $(id).disabled = false; }
  };
}

// --- Drawers ---
async function openPerformance(id) {
  closeComparison(); selectedId = id; $('include-recording').checked = false;
  const entry = app.history.find(item => item.id === id);
  $('original-transcript').hidden = typeof entry?.rawText !== 'string' || entry.rawText === entry.text;
  $('original-transcript').open = false; $('original-text').textContent = entry?.rawText || '';
  $('performance-drawer').hidden = false; $('drawer-backdrop').hidden = false;
  await renderPerformance(); $('close-drawer').focus();
}
function closePerformance() { selectedId = null; $('performance-drawer').hidden = true; if ($('comparison-drawer').hidden) $('drawer-backdrop').hidden = true; }
function closeComparison() { comparisonId = null; $('comparison-drawer').hidden = true; if ($('performance-drawer').hidden) $('drawer-backdrop').hidden = true; }
function closeDrawers() { closePerformance(); closeComparison(); }
$('close-drawer').onclick = closePerformance; $('close-comparison').onclick = closeComparison; $('drawer-backdrop').onclick = closeDrawers;
$('include-recording').onchange = () => renderPerformance();
$('export-timings').onclick = () => call('exportTimings', { id: selectedId }).catch(fail);
async function renderPerformance() {
  const id = selectedId; if (!id) return;
  try {
    const result = await call('timings', { id, includeRecording: $('include-recording').checked });
    if (id !== selectedId || !result) return;
    const { metrics, chart } = result;
    $('latency-value').textContent = metrics.pasteMs != null && metrics.stopMs != null ? `${((metrics.pasteMs - metrics.stopMs) / 1000).toFixed(2)} s` : 'Not pasted';
    $('latency-caption').textContent = metrics.pasteMs != null ? 'From finishing your recording to pasting.' : metrics.outcome;
    $('timings').replaceChildren(...chart.rows.map(row => {
      const element = el('div', 'timing-row' + (row.name.includes('Transcribe audio') || row.name.includes('Wait for response') ? ' wait' : '')); element.dataset.stage = row.name;
      const label = el('div', 'timing-name', row.name.replace('Part 1 · ', '')); label.title = row.name;
      const track = el('div', 'timing-track'), bar = el('div', 'timing-bar'), duration = Math.max(1, chart.duration);
      bar.style.left = `${Math.max(0, row.start / duration * 100)}%`; bar.style.width = `${Math.min(100, row.duration / duration * 100)}%`; track.append(bar);
      element.append(label, track, el('div', 'timing-value', formatDuration(row.duration))); return element;
    }));
    $('timing-note').textContent = $('include-recording').checked ? 'Full session, including speaking time and clipboard cleanup.' : `Speaking time and clipboard cleanup are excluded.${chart.completedEarly ? ` ${chart.completedEarly} stages finished before you stopped.` : ''}`;
    const facts = [...pipelineFacts(metrics), ['Audio length', `${Number(metrics.audioSeconds || 0).toFixed(1)} s`], ['Request size', `${((metrics.requestBytes || 0) / 1024).toFixed(0)} KB`]];
    if (metrics.firstTranscriptMs != null) facts.push(['First transcript', formatDuration(metrics.firstTranscriptMs)]);
    facts.push(...streamingFacts(metrics, modelNames, formatDuration));
    for (const hedge of metrics.hedges ?? []) facts.push(['Hedge', hedge.savedMs != null ? `saved ≈ ${formatDuration(hedge.savedMs)}` : `fired after ${formatDuration(hedge.cutoffMs)}`]);
    const requests = metrics.parallelRequests?.length ? metrics.parallelRequests : (metrics.requests ?? []);
    requests.forEach((request, index) => facts.push([`Request ${request.attempt ?? index + 1}${request.selected ? ' · used' : ''}`, `${modelNames[request.model] || request.model} · ${formatDuration(request.durationMs)} · ${request.outcome}`]));
    for (const fallback of metrics.fallbacks ?? []) facts.push(['Fallback from', `${modelNames[fallback.model] || fallback.model}: ${fallback.error}`]);
    $('timing-facts').replaceChildren(...facts.map(([name, text]) => { const item = el('div', '', name); item.append(el('strong', '', text)); return item; }));
  } catch (error) { fail(error); }
}
function renderComparison() {
  const entry = app.history.find(item => item.id === comparisonId);
  if (!entry) { closeComparison(); return; }
  const versions = [{ id: null, text: entry.text, metrics: entry.metrics, primary: true }, ...(entry.alternatives || [])];
  $('comparison-versions').replaceChildren(...versions.map(version => {
    const card = el('article', 'transcript-version'); if (version.id) card.dataset.alternateId = version.id;
    const header = el('div', 'version-header'); header.append(el('strong', '', pipelineFacts(version.metrics)[0]?.[1] || 'Unknown model'), el('span', '', version.primary ? 'Current' : 'Alternate'));
    const actions = el('div', 'version-actions');
    const copy = el('button', 'secondary-button', 'Copy'); copy.dataset.action = 'copy';
    copy.onclick = () => call('copyTranscriptVersion', { id: entry.id, alternateId: version.id }).then(() => toast('Copied')).catch(fail);
    actions.append(copy);
    if (!version.primary) {
      const primary = el('button', 'secondary-button', 'Use this version'); primary.title = 'Replace the transcript in History with this version. The current one is kept as an alternate.'; primary.dataset.action = 'make-primary';
      primary.onclick = () => call('makeTranscriptPrimary', { id: entry.id, alternateId: version.id }).then(() => toast('History now uses this version')).catch(fail);
      actions.append(primary);
    }
    card.append(header, el('p', 'transcript-text', version.text), actions); return card;
  }));
  const primaryModel = entry.metrics?.transcriptionModel, dictionary = app.settings.dictionaryTerms || [];
  for (const option of $('alternate-model').options) {
    const model = app.settings.models?.find(item => item.id === option.value);
    const hasKey = model && app.settings[({ openrouter: 'hasKey', xai: 'hasXaiKey', gateway: 'hasGatewayKey' })[model.credential]];
    const compatible = model && (!model.dictionaryHints || (dictionary.length <= model.maxDictionaryTerms && dictionary.every(term => term.length <= model.maxTermLength)));
    option.disabled = option.value === primaryModel || !hasKey || !compatible;
  }
  if ($('alternate-model').selectedOptions[0]?.disabled) $('alternate-model').value = [...$('alternate-model').options].find(option => !option.disabled)?.value || '';
  $('create-alternate').disabled = !$('alternate-model').value;
}
function openComparison(id) { closePerformance(); comparisonId = id; $('comparison-drawer').hidden = false; $('drawer-backdrop').hidden = false; renderComparison(); $('close-comparison').focus(); }
$('create-alternate').onclick = async () => {
  const button = $('create-alternate'), id = comparisonId, model = $('alternate-model').value;
  if (!id || !model) return;
  button.disabled = true; button.textContent = 'Transcribing…';
  try { await call('transcribeAlternate', { id, model }); toast('Alternate transcript added'); } catch (error) { fail(error); }
  finally { button.textContent = 'Transcribe'; if (comparisonId) renderComparison(); }
};
