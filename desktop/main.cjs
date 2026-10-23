const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, clipboard, safeStorage, dialog, Notification, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { projectTimings } = require('./model.cjs');
const { HistoryStore } = require('./history-store.cjs');
const { getWordStats, getDisplayedCostStats } = require('./stats.cjs');
const { readWisprDictionary } = require('./wispr-dictionary.cjs');
const { startAutoUpdates } = require('./updater.cjs');
const { DictionarySync } = require('./dictionary-sync.cjs');
const { ItemSync, itemValuesFromEngine, engineChangesFromItems } = require('./item-sync.cjs');
const { Account } = require('./account.cjs');
const { definition: modelDefinition, validateModelDictionary } = require('./transcription-models.cjs');
const testMode = process.argv.includes('--ui-test');
const startupMode = process.argv.includes('--startup');
app.setName('Local Whisper');
if (testMode) app.setPath('userData', path.join(app.getPath('temp'), 'local-whisper-ui-test'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let main, overlay, learning, tray, engine, quitting = false, state = { mode: 'Idle' }, history = [], historyError = false;
  const testOverlayActions = [];
  let nextId = 0, settings = {}, balance = null, gatewayBalance = null, gatewayRefreshPromise, costLedger = null, refreshPromise, saveQueue = Promise.resolve(), updateReadyVersion = null;
  const pending = new Map();
  const learningToasts = new Map();
  const currentCosts = () => getDisplayedCostStats(history, costLedger);
  const historyPath = () => path.join(app.getPath('userData'), 'history.sqlite');
  const historyStore = new HistoryStore(historyPath(), safeStorage, path.join(app.getPath('userData'), 'history.bin'));
  const broadcast = value => { for (const win of [main, overlay]) if (win && !win.isDestroyed()) win.webContents.send('event', value); };
  const account = new Account({
    file: path.join(app.getPath('userData'), 'account.bin'), crypto: safeStorage,
    onChange: () => broadcastAccount()
  });
  const dictionarySync = new DictionarySync({
    file: path.join(app.getPath('userData'), 'dictionary-sync.bin'), crypto: safeStorage, account,
    readTerms: () => settings.dictionaryTerms || [],
    writeTerms: async dictionaryTerms => {
      if (state.mode !== 'Idle') throw new Error('Finish recording to receive dictionary changes');
      validateModelDictionary(settings, settings.transcriptionModel, dictionaryTerms);
      settings = testMode ? { ...settings, dictionaryTerms } : await send('saveDictionary', { dictionaryTerms, preserveLearning: true, expectedDictionaryTerms: settings.dictionaryTerms || [] });
      broadcast({ type: 'dictionarySynced', settings });
    },
    onStatus: () => broadcastAccount()
  });
  // Settings and API keys follow the account. Keys are sealed here, in the main process; the renderer never receives them.
  async function readSyncState() {
    return itemValuesFromEngine(testMode
      ? { settings: { transcriptionModel: settings.transcriptionModel, cleanupMode: settings.cleanupMode, raceMai: settings.doubleTranscription }, secrets: {} }
      : await send('syncState'));
  }
  // Returns the names it could not apply (for example while recording); they are retried on the next sync.
  async function writeSyncState(changes) {
    if (state.mode !== 'Idle') return Object.keys(changes);
    const { payload, refused } = engineChangesFromItems(changes);
    if (testMode) return refused;
    const result = await send('applySyncState', payload);
    settings = result.settings; broadcast({ type: 'settings', settings });
    if (Object.keys(payload.secrets).length) refreshCredits();
    return [...refused, ...result.rejected];
  }
  const itemSync = new ItemSync({
    file: path.join(app.getPath('userData'), 'account-items.bin'), crypto: safeStorage,
    account, local: { read: readSyncState, write: writeSyncState },
    onStatus: () => broadcastAccount()
  });
  const accountStatus = () => ({ account: account.status(), dictionary: dictionarySync.status(), items: itemSync.status() });
  const broadcastAccount = () => broadcast({ type: 'dictionarySyncStatus', sync: accountStatus() });
  // Items first: their reply carries this device's current grants, which say which dictionary list to sync.
  const syncAccount = () => itemSync.sync().then(() => dictionarySync.sync()).then(accountStatus);
  // Joining or leaving an account starts both syncs from scratch, so local values merge instead of looking deleted.
  async function joined() { await itemSync.forget(); await dictionarySync.resetAccount(); return syncAccount(); }
  const text = (value, limit = 256) => typeof value === 'string' && value.length <= limit ? value : null;
  function grantsFrom(value) {
    if (!value || typeof value.secrets !== 'boolean' || typeof value.settings !== 'boolean') throw new Error('Choose what this device syncs.');
    const dictionary = value.dictionary === null ? null : text(value.dictionary, 30)?.trim();
    if (dictionary === undefined || (dictionary !== null && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/.test(dictionary))) throw new Error('Dictionary list names use letters, numbers, spaces, hyphens or underscores (up to 30).');
    return { secrets: value.secrets, settings: value.settings, history: false, dictionary };
  }
  function send(method, params = {}, timeoutMs = 16000) {
    return new Promise((resolve, reject) => {
      if (!engine || engine.killed || !engine.stdin.writable) return reject(new Error('Dictation engine is unavailable. Restart the app.'));
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('The request timed out. Please try again.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      engine.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async function saveHistory() {
    if (testMode) return;
    if (historyError) throw new Error('History could not be read. The existing file has been left untouched.');
    saveQueue = historyStore.write(history);
    return saveQueue;
  }
  function notify(message) {
    broadcast({ type: 'notice', message });
    if (!testMode && !main?.isFocused()) new Notification({ title: 'Local Whisper', body: message }).show();
  }
  const latestText = () => history.find(entry => entry.text)?.text || '';
  function copyLatest() {
    const text = latestText();
    if (!text) throw new Error('No transcript to copy yet.');
    clipboard.writeText(text); return true;
  }
  function updateTrayMenu() {
    if (!tray) return;
    const hasTranscript = history.some(entry => entry.text);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Local Whisper', click: () => showMain() },
      { label: 'Settings', click: () => showMain('settings') },
      { type: 'separator' },
      { label: 'Copy last transcript', enabled: hasTranscript, click: () => { try { copyLatest(); broadcast({ type: 'notice', message: 'Last transcript copied' }); } catch {} } },
      { type: 'separator' },
      ...(updateReadyVersion ? [{ label: `Update ${updateReadyVersion} ready · Quit to install`, click: () => app.quit() }] : []),
      { label: 'Quit', click: () => app.quit() }
    ]));
  }
  function notifyCopy(message, textToCopy) {
    broadcast({ type: 'notice', message });
    if (testMode || main?.isFocused() || !textToCopy) return;
    const note = new Notification({ title: 'Local Whisper', body: message, actions: [{ type: 'button', text: 'Copy transcript' }] });
    note.on('action', () => clipboard.writeText(textToCopy));
    note.on('click', () => { clipboard.writeText(textToCopy); showMain('history'); });
    note.show();
  }
  function showLearningToast(id, term) {
    learningToasts.set(id, term);
    while (learningToasts.size > 3) learningToasts.delete(learningToasts.keys().next().value);
    const height = 72 + learningToasts.size * 38;
    learning.setSize(360, height);
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    learning.setPosition(area.x + area.width - 378, area.y + area.height - height - 16);
    learning.webContents.send('event', { type: 'learningToast', id, term });
    learning.showInactive();
    learning.moveTop();
  }
  function persist(audioById) {
    if (testMode) return;
    if (historyError) { notify('Could not save history. Your current transcripts are still available in this window.'); return; }
    saveQueue = historyStore.write(history, audioById);
    saveQueue.catch(() => notify('Could not save history. Your current transcripts are still available in this window.'));
  }
  async function transcribeSavedRecording(entry, model, fallback = false) {
    const recording = await historyStore.readAudio(entry.id);
    if (!recording) throw new Error('The saved recording could not be found.');
    const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'local-whisper-transcribe-'));
    const extension = recording.format === 'mp3' ? 'mp3' : 'wav';
    const audioPath = path.join(directory, `recording.${extension}`);
    try {
      await fs.writeFile(audioPath, recording.bytes);
      return await send('transcribeFile', { path: audioPath, format: extension, model, fallback }, 180000);
    } finally {
      await fs.unlink(audioPath).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  }
  function showMain(view = 'history') { main.show(); main.focus(); broadcast({ type: 'navigate', view }); }
  function engineEvent(event) {
    if (event.type === 'reply') {
      const request = pending.get(event.id);
      if (request) { clearTimeout(request.timeout); pending.delete(event.id); event.error ? request.reject(new Error(event.error)) : request.resolve(event.result); }
      return;
    }
    if (event.type === 'ready') { settings = event.settings; refreshCredits(); syncAccount(); }
    if (event.type === 'settings') settings = event.settings;
    if (event.type === 'dictionaryLearned') {
      settings = event.settings;
      dictionarySync.sync();
      broadcast({ type: 'dictionaryLearned', term: event.term, settings });
      showLearningToast(event.id, event.term);
      return;
    }
    if (event.type === 'dictionaryLearningUndone') {
      settings = event.settings;
      dictionarySync.sync();
      for (const [id, term] of learningToasts) if (term === event.term) learningToasts.delete(id);
      learning.webContents.send('event', { type: 'dictionaryLearningUndone', term: event.term });
    }
    if (event.type === 'state') {
      const wasIdle = state.mode === 'Idle'; state = event;
      const overlayInteractive = event.mode === 'LockMode';
      overlay.setIgnoreMouseEvents(!overlayInteractive);
      if (event.mode === 'Idle') overlay.hide();
      else {
        if (wasIdle) {
          const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
          overlay.setPosition(Math.round(area.x + (area.width - 192) / 2), area.y + area.height - 64);
        }
        if (!overlay.isVisible()) {
          overlay.showInactive();
          overlay.setAlwaysOnTop(true, 'screen-saver');
          overlay.moveTop();
        }
      }
    }
    if (event.type === 'transcript') {
      const { audio, audioFormat, ...rest } = event.entry;
      const recording = typeof audio === 'string' ? Buffer.from(audio, 'base64') : null;
      const entry = { ...rest, hasAudio: recording !== null };
      history.unshift(entry);
      updateTrayMenu();
      if (entry.text && entry.metrics?.outcome === 'Saved to history') {
        let copied = true;
        try { clipboard.writeText(entry.text); }
        catch { copied = false; }
        notifyCopy(copied
          ? "Couldn't paste. Your transcript was copied to the clipboard."
          : "Couldn't paste, and your transcript could not be copied automatically.", entry.text);
      }
      persist(recording ? new Map([[entry.id, { bytes: recording, format: audioFormat || 'wav' }]]) : undefined);
      refreshCredits(); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() });
      event = { ...event, entry };
    }
    if (event.type === 'metricsUpdated') {
      const entry = history.find(x => x.id === event.id);
      if (entry) { entry.metrics = event.metrics; persist(); }
    }
    if (event.type === 'needsSettings') showMain('settings');
    // Legacy engine binaries emit this notice before the transcript arrives; the
    // transcript handler above already copies the text and shows the Copy action.
    if (event.type === 'notice') { if (event.message === 'Focus changed. Your transcript is ready in History.') return; notify(event.message); return; }
    broadcast(event);
  }
  async function refreshGatewayCredits() {
    if (!settings.hasGatewayKey || settings.transcriptionModel !== 'mai-transcribe-2-streaming') {
      gatewayBalance = null;
      return null;
    }
    if (testMode) return gatewayBalance;
    if (gatewayRefreshPromise) return gatewayRefreshPromise;
    gatewayRefreshPromise = send('gatewayCredits')
      .then(value => { gatewayBalance = value; broadcast({ type: 'gatewayBalance', balance: value }); return value; })
      .catch(error => { broadcast({ type: 'gatewayBalanceError' }); return { error: error.message }; })
      .finally(() => { gatewayRefreshPromise = null; });
    return gatewayRefreshPromise;
  }
  async function refreshCredits() {
    refreshGatewayCredits();
    if (testMode) return balance;
    if (refreshPromise) return refreshPromise;
    refreshPromise = send('credits').then(value => { balance = value; broadcast({ type: 'balance', balance }); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() }); return balance; })
      .catch(error => { broadcast({ type: 'balanceError', message: error.message }); return { error: error.message }; })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  function startEngine() {
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'engine', 'LocalWhisper.exe') : path.join(__dirname, '..', 'dist', 'engine', 'LocalWhisper.exe');
    engine = spawn(executable, ['--engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: engine.stdout });
    lines.on('line', line => { try { engineEvent(JSON.parse(line)); } catch { notify('A response from the dictation engine could not be read.'); } });
    engine.stdin.on('error', () => {});
    engine.stderr.on('data', () => {}); // Never forward raw diagnostic data to renderer or logs.
    engine.on('error', () => notify('Could not start the dictation engine. Restart Local Whisper.'));
    engine.on('exit', () => {
      overlay.hide(); state = { mode: 'Idle' }; broadcast({ type: 'engineOffline' });
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Dictation engine stopped.')); }
      pending.clear();
      if (!quitting) notify('The dictation engine stopped. Restart Local Whisper to reconnect.');
    });
  }
  function secure(win, file) {
    const allowed = pathToFileURL(path.join(__dirname, file)).href;
    const privacyLinks = new Set([
      'https://openrouter.ai/docs/guides/privacy/data-collection',
      'https://openrouter.ai/settings/privacy',
      'https://developers.openai.com/api/docs/guides/your-data',
      'https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security'
    ]);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (file === 'index.html' && privacyLinks.has(url))
        shell.openExternal(url).catch(() => notify('Could not open the privacy policy in your browser.'));
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => { if (url !== allowed) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    return win.loadFile(file);
  }
  function validateDictionaryTerms(terms) {
    if (!Array.isArray(terms) || terms.length > 1000 || terms.some(term => typeof term !== 'string' || term.length > 120) || terms.join('\n').length > 12000)
      throw new Error('Invalid dictionary terms. Use up to 1000 terms, 120 characters each, and 12000 characters total.');
  }
  function mergeDictionaryTerms(current, imported) {
    const merged = [], seen = new Set();
    for (const value of [...current, ...imported]) {
      const term = value.trim(); if (!term) continue;
      const key = term.toLocaleLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(term); }
    }
    validateDictionaryTerms(merged); return merged;
  }
  ipcMain.handle('command', async (event, method, params = {}) => {
    const isMain = main && event.sender === main.webContents;
    const isOverlay = overlay && event.sender === overlay.webContents;
    const isLearning = learning && event.sender === learning.webContents;
    if (!isMain && !isOverlay && !isLearning) throw new Error('Unknown window.');
    if (isLearning) {
      if (method === 'hideLearningToast') { learning.hide(); learningToasts.clear(); return true; }
      if (method !== 'undoLearning' || !params || typeof params.id !== 'string' || !learningToasts.has(params.id)) throw new Error('Unknown learning action.');
      if (testMode) {
        const term = learningToasts.get(params.id);
        engineEvent({ type: 'dictionaryLearningUndone', term, settings: { ...settings, dictionaryTerms: settings.dictionaryTerms.filter(value => value !== term) } });
        return true;
      }
      return send('undoLearning', { id: params.id });
    }
    if (isOverlay) {
      if (method === 'initial') return { state };
      if (!['cancel', 'finish'].includes(method)) throw new Error('Unknown toolbar action.');
      if (testMode) { testOverlayActions.push(method); return null; }
      return send(method, method === 'finish' ? { fromOverlay: true } : {});
    }
    switch (method) {
      case 'initial': return { history, settings, balance, gatewayBalance, state, historyError, dictionarySync: accountStatus(), stats: getWordStats(history), costs: currentCosts() };
      case 'microphones': return testMode ? settings.microphones || [] : send('microphones');
      case 'captureShortcut':
        if (typeof params?.enabled !== 'boolean') throw new Error('Invalid shortcut capture.');
        if (params.enabled && !main.isFocused() && !testMode) throw new Error('Focus Settings before changing the shortcut.');
        return testMode ? null : send(method, params);
      case 'startMicrophoneTest':
        if (typeof params?.microphoneDeviceId !== 'string' || params.microphoneDeviceId.length > 2048) throw new Error('Invalid microphone selection.');
        if (!main.isFocused() && !testMode) throw new Error('Focus Settings before testing the microphone.');
        return testMode ? null : send(method, params);
      case 'stopMicrophoneTest':
        if (typeof params?.playback !== 'boolean') throw new Error('Invalid microphone test.');
        if (testMode) { broadcast({ type: 'microphoneTestStopped', audio: null }); return null; }
        return send(method, params);
      case 'configureDictionarySync': {
        if (typeof params.url !== 'string' || typeof params.key !== 'string') throw new Error('Invalid sync settings.');
        await dictionarySync.configure(params.url.trim(), params.key.trim());
        await dictionarySync.sync(); return accountStatus();
      }
      case 'syncDictionary': return syncAccount();
      case 'accountCreate':
      case 'accountSignIn': {
        const url = text(params?.url), username = text(params?.username), passphrase = text(params?.passphrase);
        if (!url || !username || !passphrase) throw new Error('Enter your username and passphrase.');
        try { await (method === 'accountCreate' ? account.createAccount(url.trim(), username, passphrase) : account.signIn(url.trim(), username, passphrase)); }
        finally { params.passphrase = ''; }
        return joined();
      }
      case 'accountPair': {
        const url = text(params?.url), code = text(params?.code, 40);
        if (!url || !code) throw new Error('Enter the pairing code from your desktop.');
        await account.pair(url.trim(), code);
        return joined();
      }
      case 'accountSignOut':
        await account.signOut(); await itemSync.forget(); await dictionarySync.resetAccount();
        return accountStatus();
      case 'accountDevices': return testMode ? { devices: [{ id: 'd1', name: 'Desk', admin: true, hasKeys: true, current: true, lastSeen: Date.now(), grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } }, { id: 'd2', name: 'Work laptop', admin: false, hasKeys: false, current: false, lastSeen: Date.now() - 3 * 3600000, grants: { secrets: false, settings: true, history: false, dictionary: 'Work' } }], lists: ['Personal', 'Work'] } : account.listDevices();
      case 'accountAddDevice': {
        const name = text(params?.name, 60)?.trim();
        if (!name) throw new Error('Name the device, for example Phone or Work laptop.');
        return account.addDevice({ name, grants: grantsFrom(params.grants) });
      }
      case 'accountUpdateDevice': {
        if (!text(params?.id, 64)) throw new Error('Choose a device.');
        await account.updateDevice(params.id, { grants: grantsFrom(params.grants), ...(text(params.name, 60)?.trim() ? { name: params.name.trim() } : {}) });
        syncAccount();
        return account.listDevices();
      }
      case 'accountRemoveDevice':
        if (!text(params?.id, 64)) throw new Error('Choose a device.');
        await account.removeDevice(params.id);
        return account.listDevices();
      case 'accountChangePassphrase': {
        const passphrase = text(params?.passphrase);
        if (!passphrase) throw new Error('Enter a new passphrase.');
        try { await account.changePassphrase(passphrase); } finally { params.passphrase = ''; }
        return accountStatus();
      }
      case 'refreshCredits': return refreshCredits();
      case 'refreshGatewayCredits': return refreshGatewayCredits();
      case 'importOpenRouterActivity': {
        if (!params || typeof params.managementKey !== 'string' || !params.managementKey.trim() || params.managementKey.length > 1024)
          throw new Error('Enter a temporary OpenRouter management key.');
        let imported;
        try { imported = testMode ? require('./tests/fixtures.cjs').activityImport : await send('importActivity', { managementKey: params.managementKey.trim() }, 30000); }
        finally { params.managementKey = ''; }
        await historyStore.replaceCostLedger(imported);
        costLedger = imported;
        const costs = currentCosts();
        broadcast({ type: 'stats', stats: getWordStats(history), costs });
        return { importedAt: imported.importedAt, through: imported.through, rows: imported.rows.length, costs };
      }
      case 'setLockMode': {
        if (!params || typeof params.lockMode !== 'boolean') throw new Error('Invalid settings.');
        settings = testMode ? { ...settings, lockMode: params.lockMode } : await send('setLockMode', params);
        broadcast({ type: 'settings', settings }); return settings;
      }
      case 'saveSettings': {
        if (params?.shortcut != null && (!Number.isInteger(params.shortcut.modifiers) || params.shortcut.modifiers < 1 || params.shortcut.modifiers > 15 || !Number.isInteger(params.shortcut.key) || params.shortcut.key < 0 || params.shortcut.key > 255)) throw new Error('Invalid shortcut.');
        if (params?.microphoneDeviceId != null && (typeof params.microphoneDeviceId !== 'string' || params.microphoneDeviceId.length > 2048)) throw new Error('Invalid microphone selection.');
        if (!params || typeof params.liveChunks !== 'boolean' || typeof params.doubleTranscription !== 'boolean' || typeof params.lockMode !== 'boolean' || typeof params.autoLearn !== 'boolean' || ['apiKey', 'xaiApiKey', 'gatewayApiKey'].some(name => params[name] != null && (typeof params[name] !== 'string' || params[name].length > 1024))) throw new Error('Invalid settings.');
        modelDefinition(settings, params.transcriptionModel);
        if (!['off', 'luna', 'luna-fast'].includes(params.cleanupMode)) throw new Error('Invalid cleanup mode.');
        validateDictionaryTerms(params.dictionaryTerms);
        validateModelDictionary(settings, params.transcriptionModel, params.dictionaryTerms);
        settings = testMode ? { ...settings, hasXaiKey: settings.hasXaiKey || !!params.xaiApiKey, hasGatewayKey: settings.hasGatewayKey || !!params.gatewayApiKey, liveChunks: params.liveChunks, doubleTranscription: params.doubleTranscription, lockMode: params.lockMode, autoLearn: params.autoLearn, transcriptionModel: params.transcriptionModel, cleanupMode: params.cleanupMode, shortcut: params.shortcut ?? settings.shortcut, microphoneDeviceId: params.microphoneDeviceId ?? settings.microphoneDeviceId ?? '', dictionaryTerms: params.dictionaryTerms } : await send('saveSettings', params);
        broadcast({ type: 'settings', settings }); refreshCredits(); syncAccount(); return settings;
      }
      case 'importWisprDictionary': {
        validateDictionaryTerms(params.dictionaryTerms);
        const imported = testMode
          ? { terms: ['Wispr Flow', 'Astra'], skippedSnippets: 3, convertedReplacements: 1 }
          : readWisprDictionary(path.join(app.getPath('appData'), 'Wispr Flow', 'flow.sqlite'));
        const before = new Set(params.dictionaryTerms.map(term => term.trim().toLocaleLowerCase()).filter(Boolean)).size;
        const dictionaryTerms = mergeDictionaryTerms(params.dictionaryTerms, imported.terms);
        settings = testMode ? { ...settings, dictionaryTerms } : await send('saveDictionary', { dictionaryTerms });
        dictionarySync.sync();
        return { settings, added: dictionaryTerms.length - before, ...imported };
      }
      case 'copy': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        await clipboard.writeText(entry.text); return true;
      }
      case 'copyTranscriptVersion': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        const version = params.alternateId ? entry.alternatives?.find(x => x.id === params.alternateId) : entry;
        if (!version?.text) throw new Error('Transcript version no longer exists.');
        clipboard.writeText(version.text); return true;
      }
      case 'copyLast': return copyLatest();
      case 'audio': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const recording = await historyStore.readAudio(entry.id);
        if (!recording) throw new Error('The saved recording could not be found.');
        return { bytes: recording.bytes, format: recording.format };
      }
      case 'downloadAudio': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const recording = await historyStore.readAudio(entry.id);
        if (!recording) throw new Error('The saved recording could not be found.');
        const stamp = new Date(entry.metrics.started).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const result = await dialog.showSaveDialog(main, { defaultPath: `recording-${stamp}.wav`, filters: [{ name: 'WAV audio', extensions: ['wav'] }] });
        if (result.canceled) return false;
        await fs.writeFile(result.filePath, recording.bytes); return true;
      }
      case 'transcribeAlternate': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const allowedModels = (settings.models || []).map(model => model.id);
        if (!allowedModels.includes(params.model)) throw new Error('Choose a valid transcription model.');
        let updated;
        if (testMode) {
          updated = { text: `Alternate from ${params.model}.`, rawText: `Alternate from ${params.model}.`, metrics: { ...entry.metrics, started: new Date().toISOString(), costs: [], transcriptionModel: params.model, requestedTranscriptionModel: params.model, cleanupMode: 'off', outcome: 'Alternate transcript' } };
        } else {
          updated = await transcribeSavedRecording(entry, params.model);
        }
        const alternate = { id: randomUUID(), text: updated.text, rawText: updated.rawText, metrics: updated.metrics };
        entry.alternatives = [...(entry.alternatives || []).filter(item => item.metrics?.transcriptionModel !== params.model), alternate];
        await saveHistory();
        broadcast({ type: 'history', history }); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() });
        return alternate;
      }
      case 'makeTranscriptPrimary': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        const alternatives = entry.alternatives || [];
        const selected = alternatives.find(item => item.id === params.alternateId);
        if (!selected) throw new Error('Alternate transcript no longer exists.');
        const recordingStarted = entry.metrics.started;
        const previous = { id: randomUUID(), text: entry.text, ...(typeof entry.rawText === 'string' ? { rawText: entry.rawText } : {}), metrics: entry.metrics };
        entry.text = selected.text; entry.rawText = selected.rawText;
        entry.metrics = { ...selected.metrics, transcribedAt: selected.metrics.transcribedAt || selected.metrics.started, started: recordingStarted };
        entry.alternatives = [...alternatives.filter(item => item.id !== selected.id), previous];
        await saveHistory(); updateTrayMenu();
        broadcast({ type: 'history', history }); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() });
        return true;
      }
      case 'delete': history = history.filter(x => x.id !== params.id); await saveHistory(); updateTrayMenu(); broadcast({ type: 'history', history }); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() }); return true;
      case 'retranscribe': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const requestedModel = entry.metrics?.requestedTranscriptionModel || entry.metrics?.transcriptionModel || settings.transcriptionModel || 'mai-transcribe-2-clean';
        const updated = testMode ? { id: entry.id, text: 'Retried transcript.', rawText: 'Retried transcript.', metrics: entry.metrics } : await transcribeSavedRecording(entry, requestedModel, true);
        entry.text = updated.text; entry.rawText = updated.rawText; entry.metrics = updated.metrics;
        updateTrayMenu(); await saveHistory();
        broadcast({ type: 'history', history }); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() });
        return true;
      }
      case 'timings': {
        const entry = history.find(x => x.id === params.id); if (!entry) return null;
        return { metrics: entry.metrics, chart: projectTimings(entry.metrics, params.includeRecording === true) };
      }
      case 'exportTimings': {
        const entry = history.find(x => x.id === params.id); if (!entry) return;
        const result = await dialog.showSaveDialog(main, { defaultPath: 'dictation-timings.json', filters: [{ name: 'Timing data', extensions: ['json'] }] });
        if (!result.canceled) await fs.writeFile(result.filePath, JSON.stringify(entry.metrics, null, 2)); return;
      }
      case 'minimize': main.minimize(); return;
      case 'maximize': main.isMaximized() ? main.unmaximize() : main.maximize(); return;
      case 'close': main.hide(); return;
      default: throw new Error('Unknown action.');
    }
  });
  app.on('second-instance', () => main && showMain());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    if (engine?.stdin.writable) engine.stdin.write(JSON.stringify({ id: 0, method: 'shutdown' }) + '\n');
    Promise.race([saveQueue.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]).finally(() => {
      if (engine && !engine.killed) engine.kill(); tray?.destroy(); app.quit();
    });
  });
  app.whenReady().then(async () => {
    if (!testMode) { await account.load(); await dictionarySync.load(); await itemSync.load(); }
    if (!testMode) {
      try { history = await historyStore.read(); costLedger = await historyStore.readCostLedger(); }
      catch { historyError = true; }
    } else {
      ({ history, settings, balance, costLedger } = require('./tests/fixtures.cjs'));
    }
    const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
    main = new BrowserWindow({ width: 1220, height: 820, minWidth: 850, minHeight: 600, frame: false, backgroundColor: '#f5f4f0', show: false, webPreferences });
    main.on('close', event => { if (!quitting) { event.preventDefault(); main.hide(); } });
    const stopSettingsTools = () => {
      if (!testMode && engine?.stdin.writable) {
        send('captureShortcut', { enabled: false }).catch(() => {});
        send('stopMicrophoneTest', { playback: false }).catch(() => {});
      }
      if (!main.isDestroyed()) main.webContents.send('event', { type: 'settingsToolsStopped' });
    };
    main.on('blur', stopSettingsTools);
    main.on('hide', stopSettingsTools);
    main.webContents.on('render-process-gone', stopSettingsTools);
    overlay = new BrowserWindow({ width: 192, height: 56, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, webPreferences });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(true);
    learning = new BrowserWindow({ width: 360, height: 110, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, webPreferences });
    learning.setAlwaysOnTop(true, 'screen-saver');
    if (testMode) for (const win of [main, overlay]) win.webContents.on('console-message', event => console.log('renderer:', event.message));
    await Promise.all([secure(main, 'index.html'), secure(overlay, 'overlay.html'), secure(learning, 'learning-toast.html')]);
    if (!testMode) {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
      tray = new Tray(icon); tray.setToolTip('Local Whisper');
      updateTrayMenu();
      tray.on('double-click', () => showMain());
      startEngine();
      setInterval(() => { if (state.mode === 'Idle') syncAccount(); }, 60000).unref();
      startAutoUpdates(app, version => {
        if (updateReadyVersion === version) return;
        updateReadyVersion = version;
        updateTrayMenu();
        notify(`Update ${version} is ready. Quit Local Whisper to install it.`);
      });
      setInterval(() => { if (main.isVisible()) { refreshCredits(); broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() }); } }, 60000).unref();
    }
    if (!startupMode) main.show();
    if (testMode) await require('./tests/ui-smoke.cjs').run({ main, overlay, learning, app, engineEvent, testOverlayActions });
  }).catch(error => { if (testMode) console.error(error); app.exit(1); });
}
