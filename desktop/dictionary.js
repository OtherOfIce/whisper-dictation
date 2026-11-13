// Dictionary page. Every change saves straight away; words learned from corrections are marked with a sparkle.
let dictionaryFilter = 'all';
const terms = () => Array.isArray(app.settings.dictionaryTerms) ? app.settings.dictionaryTerms : [];
const isLearned = term => app.learned.has(term.toLocaleLowerCase());

async function saveDictionary(dictionaryTerms, message) {
  const previous = terms();
  app.settings = { ...app.settings, dictionaryTerms }; renderDictionary();
  try { app.settings = await call('saveDictionary', { dictionaryTerms }); renderDictionary(); if (message) toast(message.text, message.options); }
  catch (error) { app.settings = { ...app.settings, dictionaryTerms: previous }; renderDictionary(); fail(error); }
}
function removeTerm(term) {
  const before = terms();
  saveDictionary(before.filter(item => item !== term), { text: `Removed “${term}”`, options: { action: { label: 'Undo', run: () => saveDictionary(terms().includes(term) ? terms() : [...terms(), term]) } } });
}
function renderDictionary() {
  const query = $('dictionary-search').value.trim().toLocaleLowerCase();
  const all = terms();
  const shown = all.filter(term => (dictionaryFilter === 'all' || (dictionaryFilter === 'learned') === isLearned(term)) && (!query || term.toLocaleLowerCase().includes(query)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const list = $('dictionary-list');
  $('dictionary-view').querySelector('.empty-state')?.remove();
  list.replaceChildren(...shown.map(term => {
    const item = el('div', 'term');
    if (isLearned(term)) { const mark = el('span', 'learned'); mark.title = 'Learned from a correction'; mark.append(icon('sparkle')); item.append(mark); }
    const word = el('span', 'word', term); word.title = term;
    item.append(word, action('x', `Remove ${term}`, () => removeTerm(term)));
    return item;
  }));
  if (!shown.length) {
    const message = all.length ? el('p', '', 'Nothing matches. Try another search or filter.')
      : el('p', '', 'Add names, product terms or spellings the models get wrong. When you correct a dictated word, Local Whisper can add it for you.');
    list.insertAdjacentElement('afterend', emptyState(all.length ? 'No matching words.' : 'Your dictionary is empty.', message, 'book'));
  }
  const model = app.settings.models?.find(item => item.id === app.settings.transcriptionModel);
  $('dictionary-hints-note').textContent = model?.dictionaryHints === false
    ? `${all.length} word${all.length === 1 ? '' : 's'}. ${model.label} doesn't use dictionary hints; other models do.`
    : `${all.length} word${all.length === 1 ? '' : 's'} used as transcription hints.`;
  $('dictionary-hints-note').title = model ? `${model.label} accepts up to ${model.maxDictionaryTerms.toLocaleString()} terms of ${model.maxTermLength.toLocaleString()} characters.` : '';
}
for (const button of document.querySelectorAll('[data-dictionary-filter]')) button.onclick = () => {
  dictionaryFilter = button.dataset.dictionaryFilter;
  document.querySelectorAll('[data-dictionary-filter]').forEach(item => item.classList.toggle('selected', item === button));
  renderDictionary();
};
$('dictionary-search').oninput = renderDictionary;
$('dictionary-add-open').onclick = () => { $('dictionary-add').hidden = false; $('dictionary-add-open').hidden = true; $('dictionary-new-term').focus(); };
$('dictionary-add-cancel').onclick = () => { $('dictionary-add').hidden = true; $('dictionary-add-open').hidden = false; $('dictionary-new-term').value = ''; };
$('dictionary-add').onsubmit = event => {
  event.preventDefault();
  const added = $('dictionary-new-term').value.split(/[\r\n,]+/).map(term => term.trim()).filter(Boolean);
  if (!added.length) return;
  const known = new Set(terms().map(term => term.toLocaleLowerCase()));
  const fresh = added.filter(term => !known.has(term.toLocaleLowerCase()) && known.add(term.toLocaleLowerCase()));
  $('dictionary-new-term').value = '';
  if (!fresh.length) { toast('Already in your dictionary'); return; }
  saveDictionary([...terms(), ...fresh], { text: fresh.length === 1 ? `Added “${fresh[0]}”` : `Added ${fresh.length} words` });
};
$('import-wispr').onclick = async () => {
  const button = $('import-wispr'); button.disabled = true;
  try {
    const result = await call('importWisprDictionary', { dictionaryTerms: terms() });
    app.settings = result.settings; renderDictionary();
    toast(`${result.added} new word${result.added === 1 ? '' : 's'} imported from Wispr Flow${result.skippedSnippets ? `, ${result.skippedSnippets} snippets skipped` : ''}.`);
  } catch (error) { fail(error); } finally { button.disabled = false; }
};
