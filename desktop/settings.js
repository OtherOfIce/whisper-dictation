// Settings modal. Every control saves as soon as it changes; there is no Save button to forget.
let capturingShortcut = false, testingMicrophone = false, testPending = false, testAudioUrl = null, testPlayback = null;

function openSettings(tab) {
  $('settings-modal').hidden = false;
  if (tab) showTab(tab);
  renderSettings(); $('settings-modal').querySelector('.settings-dialog').focus({ preventScroll: true });
}
function closeSettings() { document.querySelectorAll('.key-row').forEach(row => delete row.dataset.replacing); stopSettingsTools(); $('settings-modal').hidden = true; for (const id of ['api-key', 'xai-api-key', 'gateway-api-key', 'management-key', 'legacy-passphrase', 'sync-recovery']) $(id).value = ''; hideRecoveryKey(); }
function showTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(button => button.classList.toggle('selected', button.dataset.tab === tab));
  document.querySelectorAll('.settings-page').forEach(page => { page.hidden = page.dataset.page !== tab; });
  if (tab !== 'general') stopSettingsTools();
  if (tab === 'sync') loadDevices();
  $('settings-modal').querySelector('.settings-body').scrollTop = 0;
}
$('open-settings').onclick = () => openSettings();
document.querySelectorAll('[data-close-settings]').forEach(node => node.onclick = closeSettings);
document.querySelectorAll('.settings-tab').forEach(button => button.onclick = () => showTab(button.dataset.tab));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || capturingShortcut) return;
  if (!$('settings-modal').hidden) closeSettings(); else closeDrawers();
});
$('setup-open-keys').onclick = () => openSettings('keys');

// Sends the full settings with `patch` applied. Blank key fields keep the saved keys.
async function saveSettings(patch, message = 'Saved') {
  const s = app.settings;
  const params = {
    apiKey: '', xaiApiKey: '', gatewayApiKey: '',
    liveChunks: !!s.liveChunks, doubleTranscription: !!s.doubleTranscription, lockMode: s.lockMode !== false, autoLearn: s.autoLearn !== false,
    pauseMedia: s.pauseMedia !== false, transcriptionModel: s.transcriptionModel || 'mai-transcribe-2-clean', cleanupMode: s.cleanupMode || 'off',
    microphoneDeviceId: s.microphoneDeviceId || '', shortcut: s.shortcut || { modifiers: 10, key: 0 }, dictionaryTerms: s.dictionaryTerms || [], ...patch
  };
  try { app.settings = await call('saveSettings', params); renderSettings(); renderAll(); renderDictionary(); if (message) toast(message); return true; }
  catch (error) { renderSettings(); fail(error); return false; }
}
const toggles = { 'lock-mode': 'lockMode', 'pause-media': 'pauseMedia', 'auto-learn': 'autoLearn', 'double-transcription': 'doubleTranscription', 'live-chunks': 'liveChunks' };
for (const [id, name] of Object.entries(toggles)) $(id).onchange = () => saveSettings({ [name]: $(id).checked });
$('transcription-model').onchange = () => saveSettings({ transcriptionModel: $('transcription-model').value }, 'Voice model changed');
$('cleanup-mode').onchange = () => saveSettings({ cleanupMode: $('cleanup-mode').value });
$('microphone-device').onchange = () => { stopSettingsTools(); saveSettings({ microphoneDeviceId: $('microphone-device').value }, 'Microphone changed'); };
const keyFields = { apiKey: 'api-key', xaiApiKey: 'xai-api-key', gatewayApiKey: 'gateway-api-key' };
for (const [name, id] of Object.entries(keyFields)) {
  const save = async () => {
    const value = $(id).value.trim();
    if (!value) { toast('Paste a key first.'); return; }
    if (await saveSettings({ [name]: value }, 'Key saved')) { $(id).value = ''; delete document.querySelector(`.key-row[data-key=${name}]`).dataset.replacing; renderSettings(); }
  };
  document.querySelector(`[data-save-key=${name}]`).onclick = save;
  $(id).onkeydown = event => { if (event.key === 'Enter') save(); };
}

function renderSettings() {
  const s = app.settings;
  if (Array.isArray(s.models)) {
    for (const model of s.models) modelNames[model.id] = model.label;
    for (const id of ['transcription-model', 'alternate-model']) {
      const select = $(id), previous = select.value;
      select.replaceChildren(...s.models.map(model => new Option(model.label, model.id)));
      if (s.models.some(model => model.id === previous)) select.value = previous;
    }
  }
  $('shortcut-value').replaceChildren(...keycaps(s.shortcut));
  $('shortcut-description').textContent = shortcutSentence();
  for (const [id, name] of Object.entries(toggles)) $(id).checked = name === 'liveChunks' || name === 'doubleTranscription' ? !!s[name] : s[name] !== false;
  $('transcription-model').value = s.transcriptionModel || 'mai-transcribe-2-clean';
  $('cleanup-mode').value = s.cleanupMode || 'off';
  renderMicrophones(s.microphones || [], s.microphoneDeviceId || '');
  for (const [name, id] of Object.entries(keyFields)) {
    const has = !!s[{ apiKey: 'hasKey', xaiApiKey: 'hasXaiKey', gatewayApiKey: 'hasGatewayKey' }[name]];
    const row = document.querySelector(`.key-row[data-key=${name}]`);
    row.querySelector('.status-pill').textContent = has ? 'Saved' : 'Not set'; row.querySelector('.status-pill').classList.toggle('ok', has);
    let saved = row.querySelector('.key-saved');
    if (!saved) {
      saved = el('div', 'key-saved', 'Saved on this device. ');
      const replace = el('button', 'secondary-button', 'Replace key'); replace.type = 'button';
      replace.onclick = () => { row.dataset.replacing = 'true'; renderSettings(); $(id).focus(); };
      saved.append(replace); row.append(saved);
    }
    const editing = !has || row.dataset.replacing === 'true';
    saved.hidden = editing; row.querySelector('.key-input').hidden = !editing;
  }
  $('keys-badge').hidden = !missingKey();
  const model = s.models?.find(item => item.id === $('transcription-model').value);
  $('live-chunks').disabled = !!model?.streaming;
  $('live-chunks-note').textContent = model?.streaming ? 'Not needed: this model already streams audio while you speak.' : 'Experimental. Uploads at pauses to shorten the wait, but can change punctuation.';
  $('double-transcription').disabled = !model?.parallelRequests;
  $('gateway-cost-card').hidden = !(s.hasGatewayKey && s.transcriptionModel === 'mai-transcribe-2-streaming');
  renderUpdate();
}
function renderMicrophones(devices, selected) {
  const options = [new Option('System default', '')];
  for (const device of devices) options.push(new Option(device.name, device.id));
  if (selected && !devices.some(device => device.id === selected)) options.push(new Option('Selected microphone (disconnected)', selected));
  $('microphone-device').replaceChildren(...options); $('microphone-device').value = selected;
}
$('refresh-microphones').onclick = async () => {
  const button = $('refresh-microphones'); button.disabled = true;
  try { const devices = await call('microphones'); app.settings.microphones = devices; renderMicrophones(devices, $('microphone-device').value); toast(`${devices.length} microphone${devices.length === 1 ? '' : 's'} found`); }
  catch (error) { fail(error); } finally { button.disabled = false; }
};

// --- Shortcut capture: press the new combination and it is saved straight away ---
function endCapture(status = '') { capturingShortcut = false; $('rebind-shortcut').textContent = 'Change'; $('shortcut-status').textContent = status; }
$('rebind-shortcut').onclick = async () => {
  const enabled = !capturingShortcut;
  try {
    await call('captureShortcut', { enabled }); capturingShortcut = enabled;
    $('rebind-shortcut').textContent = enabled ? 'Cancel' : 'Change';
    $('shortcut-status').textContent = enabled ? 'Press and release your new combination. Escape cancels.' : '';
  } catch (error) { fail(error); }
};
$('reset-shortcut').onclick = () => { call('captureShortcut', { enabled: false }).catch(() => {}); endCapture(); saveSettings({ shortcut: { modifiers: 10, key: 0 } }, 'Shortcut reset to Ctrl + Win'); };
async function shortcutCaptured(shortcut) {
  if (!capturingShortcut) return;
  if (!shortcut) { endCapture('Cancelled.'); return; }
  const { modifiers, key } = shortcut;
  const supportedKey = key === 32 || key >= 48 && key <= 57 || key >= 65 && key <= 90 || key >= 112 && key <= 135;
  const modifierCount = [1, 2, 4, 8].filter(bit => modifiers & bit).length;
  if (!(modifiers && (key ? supportedKey : modifierCount >= 2))) { endCapture('Use two modifiers, or a modifier with a letter, number, function key or Space.'); return; }
  endCapture();
  if (await saveSettings({ shortcut }, `Shortcut is now ${formatShortcut(shortcut)}`)) $('shortcut-status').textContent = '';
}

// --- Microphone test ---
function discardMicrophoneAudio() { testPlayback?.pause(); testPlayback = null; if (testAudioUrl) URL.revokeObjectURL(testAudioUrl); testAudioUrl = null; $('play-microphone-test').disabled = true; }
function resetSettingsTools() {
  if (capturingShortcut) endCapture();
  testingMicrophone = false; testPending = false;
  $('test-microphone').textContent = 'Test'; $('test-microphone').disabled = false; $('microphone-test-level').value = 0;
  $('microphone-test-status').textContent = 'Record up to five seconds and play it back. Nothing is sent or saved.';
  discardMicrophoneAudio();
}
function stopSettingsTools() {
  const active = capturingShortcut || testingMicrophone;
  resetSettingsTools();
  if (active) { call('captureShortcut', { enabled: false }).catch(() => {}); call('stopMicrophoneTest', { playback: false }).catch(() => {}); }
}
$('test-microphone').onclick = async () => {
  if (testPending) return;
  testPending = true; $('test-microphone').disabled = true;
  try {
    if (testingMicrophone) await call('stopMicrophoneTest', { playback: true });
    else {
      stopAudio(); discardMicrophoneAudio();
      await call('startMicrophoneTest', { microphoneDeviceId: $('microphone-device').value });
      testingMicrophone = true; $('test-microphone').textContent = 'Stop';
      $('microphone-test-status').textContent = 'Speak now. The test stops after five seconds.';
    }
  } catch (error) { testingMicrophone = false; $('test-microphone').textContent = 'Test'; fail(error); }
  finally { testPending = false; $('test-microphone').disabled = false; }
};
$('play-microphone-test').onclick = async () => { if (!testAudioUrl) return; testPlayback?.pause(); testPlayback = new Audio(testAudioUrl); try { await testPlayback.play(); } catch { toast('Could not play the test.'); } };
window.addEventListener('blur', () => { if (testingMicrophone || capturingShortcut) stopSettingsTools(); });
function microphoneEvent(event) {
  if (event.type === 'microphoneTestLevel' && testingMicrophone) {
    $('microphone-test-level').value = event.level;
    $('microphone-test-status').textContent = `Recording, ${event.seconds.toFixed(1)} of 5 seconds.`;
  }
  if (event.type === 'microphoneTestStopped') {
    const wanted = testingMicrophone;
    testingMicrophone = false; $('test-microphone').textContent = 'Test'; $('microphone-test-level').value = 0;
    if (event.error && wanted) fail(event.error);
    if (event.audio && wanted) {
      discardMicrophoneAudio();
      const bytes = Uint8Array.from(atob(event.audio), char => char.charCodeAt(0));
      testAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      $('play-microphone-test').disabled = false; $('microphone-test-status').textContent = 'Test ready. Press Play to hear it.';
    } else if (wanted) $('microphone-test-status').textContent = 'Test stopped.';
  }
}

// --- Cost import ---
$('import-costs').onclick = async () => {
  const button = $('import-costs'), field = $('management-key'), managementKey = field.value.trim();
  field.value = ''; $('import-costs-status').textContent = ''; button.disabled = true;
  try { const result = await call('importOpenRouterActivity', { managementKey }); renderCosts(result.costs); $('import-costs-status').textContent = `${result.rows} cost rows imported. You can delete the temporary key from OpenRouter now.`; }
  catch (error) { fail(error); } finally { button.disabled = false; }
};

// --- About and updates ---
function updateText(update) {
  switch (update?.state) {
    case 'ready': return `Version ${update.version} is ready. It installs the next time you step away, or restart now.`;
    case 'downloading': return `Downloading version ${update.version}${update.progress ? ` (${update.progress}%)` : ''}…`;
    case 'checking': return 'Checking for updates…';
    case 'error': return 'Could not check for updates. Local Whisper will try again later.';
    case 'unsupported': return 'Updates are installed by the Windows installer. This copy is a development build.';
    default: return update?.checkedAt ? `You’re up to date. Checked ${new Date(update.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : 'You’re up to date.';
  }
}
function renderUpdate() {
  const update = app.update, ready = update?.state === 'ready';
  $('settings-version').textContent = `Version ${app.version}`;
  $('about-version').textContent = `Local Whisper ${app.version}`;
  $('update-status').textContent = updateText(update);
  $('about-install').hidden = !ready; $('about-badge').hidden = !ready;
  $('about-check').disabled = $('settings-check-updates').disabled = ['checking', 'downloading', 'unsupported'].includes(update?.state) || ready;
  $('update-card').hidden = !ready;
  if (ready) { $('update-title').textContent = 'Update ready'; $('update-detail').textContent = `Version ${update.version} installs when you step away.`; }
}
const checkForUpdates = async () => { try { app.update = await call('checkForUpdates'); renderUpdate(); } catch (error) { fail(error); } };
$('about-check').onclick = checkForUpdates; $('settings-check-updates').onclick = checkForUpdates;
const installUpdate = () => call('installUpdate').catch(fail);
$('about-install').onclick = installUpdate; $('update-install').onclick = installUpdate;
$('open-logs').onclick = () => call('openLogs').catch(fail);
$('about-restart-engine').onclick = () => call('restartEngine').then(() => toast('Restarting the engine…')).catch(fail);
