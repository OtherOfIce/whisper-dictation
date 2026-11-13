// Wires engine and main-process events to the views, then loads the initial state.
function setEngineOnline(online, starting = false) {
  app.engineOnline = online;
  const status = $('engine-status');
  const needsKey = online && missingKey();
  status.classList.toggle('online', online && !needsKey); status.classList.toggle('offline', !online && !starting);
  $('engine-label').textContent = needsKey ? `Add your ${credentialNames[needsKey]} key` : online ? 'Ready to dictate' : starting ? 'Starting…' : 'Engine restarting';
  $('engine-banner').hidden = online || starting;
  renderHome();
}
$('engine-restart').onclick = () => call('restartEngine').catch(fail);
function upsertEntry(entry) {
  const index = app.history.findIndex(item => item.id === entry.id);
  if (index >= 0) app.history[index] = entry;
  else { app.history.push(entry); app.history.sort((a, b) => Date.parse(b.metrics.started) - Date.parse(a.metrics.started)); }
}

window.whisper.onEvent(event => {
  switch (event.type) {
    case 'settingsToolsStopped': resetSettingsTools(); break;
    case 'shortcutCaptured': shortcutCaptured(event.shortcut); break;
    case 'microphoneTestLevel': case 'microphoneTestStopped': microphoneEvent(event); break;
    case 'transcript': upsertEntry(event.entry); renderAll(); break;
    case 'historyEntry': upsertEntry(event.entry); renderAll(); if (event.entry.id === selectedId) renderPerformance(); break;
    case 'historyRemoved': app.history = app.history.filter(entry => entry.id !== event.id); pendingDeletes.delete(event.id); if (selectedId === event.id) closePerformance(); renderAll(); break;
    case 'history': app.history = event.history; renderAll(); break;
    case 'stats': renderCosts(event.costs); break;
    case 'balance': renderBalance(event.balance); break;
    case 'balanceError': $('balance-detail').textContent = latestBalance ? 'Refresh failed. Showing the last balance.' : 'Balance unavailable. Try refreshing.'; break;
    case 'gatewayBalance': renderGatewayBalance(event.balance); break;
    case 'gatewayBalanceError': $('gateway-balance-detail').textContent = latestGatewayBalance ? 'Refresh failed. Showing the last balance.' : 'Balance unavailable.'; break;
    case 'ready': app.settings = event.settings; setEngineOnline(true); renderSettings(); renderDictionary(); break;
    case 'settings': app.settings = event.settings; renderSettings(); setEngineOnline(app.engineOnline); renderDictionary(); break;
    case 'engineOffline': setEngineOnline(false); break;
    case 'dictionarySyncStatus': renderSync(event.sync); break;
    case 'dictionarySynced': app.settings = event.settings; renderDictionary(); break;
    case 'dictionaryLearned':
    case 'dictionaryLearningUndone':
      app.settings = event.settings ?? app.settings;
      if (Array.isArray(event.learnedTerms)) app.learned = new Set(event.learnedTerms);
      renderDictionary(); break;
    case 'update': app.update = event.update; renderUpdate(); break;
    case 'navigate': navigate(event.view, event.tab); break;
    case 'notice': toast(event.message); break;
  }
});

call('initial').then(initial => {
  app.history = initial.history; app.settings = initial.settings || {}; app.update = initial.update; app.version = initial.version || '';
  app.learned = new Set(initial.learnedTerms || []);
  renderSync(initial.dictionarySync); renderSettings(); renderAll(); renderDictionary();
  renderCosts(initial.costs); renderBalance(initial.balance); renderGatewayBalance(initial.gatewayBalance);
  setEngineOnline(!!initial.engineOnline, !initial.engineOnline);
  if (initial.historyError) toast('Saved history could not be opened. New dictations are still saved.', { duration: 9000 });
  else if (initial.skippedHistory) toast(`${initial.skippedHistory} saved transcript${initial.skippedHistory === 1 ? '' : 's'} could not be decrypted and ${initial.skippedHistory === 1 ? 'was' : 'were'} skipped.`, { duration: 9000 });
}).catch(fail);
