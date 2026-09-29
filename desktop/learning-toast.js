const entries = document.getElementById('entries');
let hideTimer;
function hideSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { entries.replaceChildren(); window.whisper.call('hideLearningToast').catch(() => {}); }, 12000);
}
window.whisper.onEvent(event => {
  if (event.type === 'learningToast') {
    const row = document.createElement('div'); row.className = 'entry'; row.dataset.id = event.id;
    const term = document.createElement('span'); term.className = 'term'; term.textContent = event.term;
    const undo = document.createElement('button'); undo.textContent = 'Undo'; undo.setAttribute('aria-label', `Undo ${event.term}`);
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        const removed = await window.whisper.call('undoLearning', { id: event.id });
        if (!removed) { undo.textContent = 'Open Dictionary'; undo.onclick = null; }
      } catch { undo.disabled = false; undo.textContent = 'Try again'; }
    };
    row.append(term, undo); entries.prepend(row);
    while (entries.children.length > 3) entries.lastElementChild.remove();
    hideSoon();
  }
  if (event.type === 'dictionaryLearningUndone') {
    for (const row of entries.children) if (row.querySelector('.term').textContent === event.term) row.remove();
    if (!entries.children.length) { clearTimeout(hideTimer); window.whisper.call('hideLearningToast').catch(() => {}); }
  }
});
