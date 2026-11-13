const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, clipboard, safeStorage, dialog, Notification, shell, powerMonitor } = require('electron');
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
const { Updater } = require('./updater.cjs');
const { DictionarySync } = require('./dictionary-sync.cjs');
const { ItemSync, itemValuesFromEngine, engineChangesFromItems } = require('./item-sync.cjs');
const { Account } = require('./account.cjs');
const { definition: modelDefinition, validateModelDictionary } = require('./transcription-models.cjs');
const testMode = process.argv.includes('--ui-test');
// This project's sync server. LOCAL_WHISPER_SYNC_URL points a development build at another deployment.
const SYNC_URL = process.env.LOCAL_WHISPER_SYNC_URL || 'https://rare-canary-989.convex.site';
const startupMode = process.argv.includes('--startup');
app.setName('Local Whisper');
if (testMode) app.setPath('userData', path.join(app.getPath('temp'), 'local-whisper-ui-test'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let main, overlay, learning, tray, engine, quitting = false, state = { mode: 'Idle' }, history = [], historyError = false;
  const testOverlayActions = [];
  let nextId = 0, settings = {}, balance = null, gatewayBalance = null, gatewayRefreshPromise, costLedger = null, refreshPromise, saveQueue = Promise.resolve();
  const busyEntries = new Set();
  // Dictionary words that came from correction learning, so the Dictionary page can mark them. Lower-cased.
  let learnedTerms = new Set();
  const learnedFile = () => path.join(app.getPath('userData'), 'dictionary-learned.json');
  const loadLearned = () => fs.readFile(learnedFile(), 'utf8').then(text => { learnedTerms = new Set(JSON.parse(text)); }, () => {});
  function noteLearned(term, learned) {
    if (typeof term !== 'string') return;
    learned ? learnedTerms.add(term.toLocaleLowerCase()) : learnedTerms.delete(term.toLocaleLowerCase());
    const current = new Set((settings.dictionaryTerms || []).map(item => item.toLocaleLowerCase()));
    for (const item of learnedTerms) if (!current.has(item)) learnedTerms.delete(item);
    if (!testMode) fs.writeFile(learnedFile(), JSON.stringify([...learnedTerms])).catch(() => {});
  }
  const updater = new Updater(app);
  const hiddenRelaunchFile = path.join(app.getPath('userData'), 'relaunch-hidden');
  const pending = new Map();
  const learningToasts = new Map();
  const currentCosts = () => getDisplayedCostStats(history, costLedger);
  const historyPath = () => path.join(app.getPath('userData'), 'history.sqlite');
  const historyStore = new HistoryStore(historyPath(), safeStorage, path.join(app.getPath('userData'), 'history.bin'));
  // The main window gets every event; the recording overlay only needs dictation state.
  const OVERLAY_EVENTS = new Set(['state']);
  const broadcast = value => {
    if (main && !main.isDestroyed()) main.webContents.send('event', value);
    if (OVERLAY_EVENTS.has(value.type) && overlay && !overlay.isDestroyed()) overlay.webContents.send('event', value);
  };
  const broadcastStats = () => broadcast({ type: 'stats', stats: getWordStats(history), costs: currentCosts() });
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
  let testSignedIn = false;
  const accountStatus = () => testMode && testSignedIn
    ? { account: { signedIn: true, kind: 'linked', name: 'Desk PC', hasKeys: true, hasRecoveryKey: true, canManage: true, message: '' }, dictionary: {}, items: { message: 'Synced' } }
    : { account: account.status(), dictionary: dictionarySync.status(), items: itemSync.status() };
  const broadcastAccount = () => broadcast({ type: 'dictionarySyncStatus', sync: accountStatus() });
  // Items first: their reply carries this device's current grants, which say which dictionary list to sync.
  const syncAccount = () => itemSync.sync().then(() => dictionarySync.sync()).then(accountStatus);
  // Joining or leaving an account starts both syncs from scratch, so local values merge instead of looking deleted.
  async function joined() { await itemSync.forget(); await dictionarySync.resetAccount(); return syncAccount(); }
  const text = (value, limit = 256) => typeof value === 'string' && value.length <= limit ? value : null;
  function send(method, params = {}, timeoutMs = 16000) {
    return new Promise((resolve, reject) => {
      if (!engine || engine.killed || !engine.stdin.writable) return reject(new Error('Dictation engine is unavailable. Restart the app.'));
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('The request timed out. Please try again.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      engine.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  // Saves one entry and tells the window. History is never rewritten wholesale.
  let saveFailedNotified = false;
  function saveEntry(entry, recording = null) {
    broadcast({ type: 'historyEntry', entry });
    if (testMode) return Promise.resolve();
    saveQueue = historyStore.upsert(entry, recording).then(() => { saveFailedNotified = false; }, error => {
      if (!saveFailedNotified) notify('Could not save history. Your transcripts are still available in this window.');
      saveFailedNotified = true; throw error;
    });
    return saveQueue;
  }
  function removeEntry(id) {
    history = history.filter(entry => entry.id !== id);
    broadcast({ type: 'historyRemoved', id }); broadcastStats(); updateTrayMenu();
    if (!testMode) saveQueue = historyStore.remove(id).catch(() => notify('Could not delete that transcript from saved history.'));
  }
  // Work that changes an entry over a long request (retry, alternate transcript) holds it, so two edits cannot interleave.
  async function withEntry(id, work) {
    const entry = history.find(item => item.id === id); if (!entry) throw new Error('Transcript no longer exists.');
    if (busyEntries.has(id)) throw new Error('This transcript is already being updated.');
    busyEntries.add(id);
    try { return await work(entry); } finally { busyEntries.delete(id); }
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
      ...(updater.status.state === 'ready' ? [{ label: `Restart to update to ${updater.status.version}`, click: () => installUpdate() }] : []),
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
  function showMain(view = 'home', tab) { main.show(); main.focus(); broadcast({ type: 'navigate', view, tab }); }
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
      noteLearned(event.term, true);
      broadcast({ type: 'dictionaryLearned', term: event.term, settings, learnedTerms: [...learnedTerms] });
      showLearningToast(event.id, event.term);
      return;
    }
    if (event.type === 'dictionaryLearningUndone') {
      settings = event.settings;
      dictionarySync.sync();
      for (const [id, term] of learningToasts) if (term === event.term) learningToasts.delete(id);
      noteLearned(event.term, false);
      broadcast({ type: 'dictionaryLearningUndone', term: event.term, settings, learnedTerms: [...learnedTerms] });
      learning.webContents.send('event', { type: 'dictionaryLearningUndone', term: event.term });
      return;
    }
    if (event.type === 'state') {
      const wasIdle = state.mode === 'Idle'; state = event; lastDictationAt = Date.now();
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
      if (!testMode) saveQueue = historyStore.upsert(entry, recording ? { bytes: recording, format: audioFormat || 'wav' } : null)
        .catch(() => notify('Could not save history. Your transcripts are still available in this window.'));
      refreshCredits(); broadcastStats();
      event = { ...event, entry };
    }
    if (event.type === 'metricsUpdated') {
      const entry = history.find(x => x.id === event.id);
      if (entry) { entry.metrics = event.metrics; saveEntry(entry).catch(() => {}); }
      return;
    }
    if (event.type === 'needsSettings') { showMain('settings', 'keys'); return; }
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
  // Engine diagnostics go to a small rotating log in userData. They never reach the renderer.
  const logFile = () => path.join(app.getPath('userData'), 'logs', 'engine.log');
  let logReady = null;
  function log(line) {
    if (testMode) return;
    logReady ??= fs.mkdir(path.dirname(logFile()), { recursive: true }).then(async () => {
      const stat = await fs.stat(logFile()).catch(() => null);
      if (stat?.size > 1_000_000) await fs.rename(logFile(), logFile() + '.1').catch(() => {});
    });
    logReady.then(() => fs.appendFile(logFile(), `${new Date().toISOString()} ${line.replace(/\s+$/, '')}\n`)).catch(() => {});
  }
  // The engine is restarted if it stops unexpectedly, backing off if it keeps failing.
  let restartDelay = 1000, engineStartedAt = 0, restartTimer = null;
  function startEngine() {
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'engine', 'LocalWhisper.exe') : path.join(__dirname, '..', 'dist', 'engine', 'LocalWhisper.exe');
    engineStartedAt = Date.now();
    const child = spawn(executable, ['--engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    engine = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { log(`unreadable engine output (${line.length} chars)`); return; }
      try { engineEvent(event); } catch (error) { log(`handling ${event?.type}: ${error.stack || error.message}`); }
    });
    child.stdin.on('error', () => {});
    createInterface({ input: child.stderr }).on('line', line => log(`[engine] ${line.slice(0, 2000)}`));
    child.on('error', error => { log(`start failed: ${error.message}`); });
    child.on('exit', code => {
      if (engine !== child) return;
      overlay.hide(); state = { mode: 'Idle' }; broadcast({ type: 'engineOffline' });
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Dictation engine stopped.')); }
      pending.clear();
      if (quitting) return;
      log(`engine exited with code ${code}`);
      if (Date.now() - engineStartedAt > 60000) restartDelay = 1000;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startEngine, restartDelay);
      if (restartDelay >= 8000) notify('The dictation engine keeps stopping. Local Whisper will keep trying to restart it.');
      restartDelay = Math.min(restartDelay * 2, 30000);
    });
  }
  function restartEngine() {
    if (testMode) return;
    restartDelay = 1000;
    if (engine && engine.exitCode === null && !engine.killed) engine.kill(); else startEngine();
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
  ipcMain.handle('command', async (event, method, params) => {
    params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
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
      case 'initial': return { history, settings, balance, gatewayBalance, state, historyError, skippedHistory: historyStore.skipped, dictionarySync: accountStatus(), stats: getWordStats(history), costs: currentCosts(), update: updater.status, version: app.getVersion(), engineOnline: testMode || (!!engine && engine.exitCode === null && !engine.killed && Object.keys(settings).length > 0), learnedTerms: [...learnedTerms] };
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
      case 'syncDictionary': return testMode ? accountStatus() : syncAccount();
      case 'syncTurnOn': {
        if (testMode) testSignedIn = true;
        const recoveryKey = testMode ? 'TEST1-TEST2-ABCDE-FGHJK-MNPQR-STVWX' : await account.turnOn(SYNC_URL);
        const sync = testMode ? accountStatus() : await joined();
        return { sync, recoveryKey };
      }
      case 'syncRecover': {
        const key = text(params.recoveryKey, 80);
        if (!key) throw new Error('Enter your recovery key.');
        await account.recover(SYNC_URL, key);
        return joined();
      }
      case 'accountSignIn': {
        const username = text(params.username), passphrase = text(params.passphrase);
        if (!username || !passphrase) throw new Error('Enter your email and passphrase.');
        try { await account.signIn(SYNC_URL, username, passphrase); } finally { params.passphrase = ''; }
        return joined();
      }
      case 'accountPair': {
        const code = text(params.code, 40);
        if (!code) throw new Error('Enter the code shown on your other device.');
        await account.pair(SYNC_URL, code);
        return joined();
      }
      case 'accountSignOut':
        if (testMode) { testSignedIn = false; return accountStatus(); }
        await account.signOut(); await itemSync.forget(); await dictionarySync.resetAccount();
        return accountStatus();
      case 'accountDevices': return testMode ? { devices: [
        { id: 'd1', name: 'Desk PC', admin: true, hasKeys: true, current: true, lastSeen: Date.now(), grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } },
        { id: 'd2', name: 'Pixel 9', admin: false, hasKeys: true, current: false, lastSeen: Date.now() - 3 * 3600000, grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } }
      ] } : account.listDevices();
      case 'accountLinkDevice': return testMode ? { code: 'K7Q2-9XMB-4TRD', expiresAt: Date.now() + 600000 } : account.linkDevice(text(params.name, 60)?.trim() || 'New device');
      case 'accountRemoveDevice':
        if (!text(params.id, 64)) throw new Error('Choose a device.');
        await account.removeDevice(params.id);
        return account.listDevices();
      case 'accountRecoveryKey': return testMode ? 'TEST1-TEST2-ABCDE-FGHJK-MNPQR-STVWX' : account.recoveryKey();
      case 'accountNewRecoveryKey': return account.newRecoveryKey();
      case 'appInfo': return { version: app.getVersion(), update: updater.status, logFolder: path.dirname(logFile()) };
      case 'checkForUpdates': return updater.check();
      case 'installUpdate': return installUpdate();
      case 'restartEngine': restartEngine(); return true;
      case 'openLogs': return shell.openPath(path.dirname(logFile()));
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
        settings = testMode ? { ...settings, hasKey: settings.hasKey || !!params.apiKey, pauseMedia: params.pauseMedia !== false, hasXaiKey: settings.hasXaiKey || !!params.xaiApiKey, hasGatewayKey: settings.hasGatewayKey || !!params.gatewayApiKey, liveChunks: params.liveChunks, doubleTranscription: params.doubleTranscription, lockMode: params.lockMode, autoLearn: params.autoLearn, transcriptionModel: params.transcriptionModel, cleanupMode: params.cleanupMode, shortcut: params.shortcut ?? settings.shortcut, microphoneDeviceId: params.microphoneDeviceId ?? settings.microphoneDeviceId ?? '', dictionaryTerms: params.dictionaryTerms } : await send('saveSettings', params);
        broadcast({ type: 'settings', settings }); refreshCredits(); syncAccount(); return settings;
      }
      case 'saveDictionary': {
        validateDictionaryTerms(params.dictionaryTerms);
        const dictionaryTerms = mergeDictionaryTerms([], params.dictionaryTerms);
        validateModelDictionary(settings, settings.transcriptionModel, dictionaryTerms);
        settings = testMode ? { ...settings, dictionaryTerms } : await send('saveDictionary', { dictionaryTerms });
        noteLearned(null);
        broadcast({ type: 'settings', settings }); dictionarySync.sync().catch(() => {});
        return settings;
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
        const extension = recording.format === 'mp3' ? 'mp3' : 'wav';
        const result = await dialog.showSaveDialog(main, { defaultPath: `recording-${stamp}.${extension}`, filters: [{ name: `${extension.toUpperCase()} audio`, extensions: [extension] }] });
        if (result.canceled) return false;
        await fs.writeFile(result.filePath, recording.bytes); return true;
      }
      case 'transcribeAlternate': return withEntry(params.id, async entry => {
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const allowedModels = (settings.models || []).map(model => model.id);
        if (!allowedModels.includes(params.model)) throw new Error('Choose a valid transcription model.');
        const updated = testMode
          ? { text: `Alternate from ${params.model}.`, rawText: `Alternate from ${params.model}.`, metrics: { ...entry.metrics, started: new Date().toISOString(), costs: [], transcriptionModel: params.model, requestedTranscriptionModel: params.model, cleanupMode: 'off', outcome: 'Alternate transcript' } }
          : await transcribeSavedRecording(entry, params.model);
        const alternate = { id: randomUUID(), text: updated.text, rawText: updated.rawText, metrics: updated.metrics };
        entry.alternatives = [...(entry.alternatives || []).filter(item => item.metrics?.transcriptionModel !== params.model), alternate];
        await saveEntry(entry); broadcastStats();
        return alternate;
      });
      case 'makeTranscriptPrimary': return withEntry(params.id, async entry => {
        const alternatives = entry.alternatives || [];
        const selected = alternatives.find(item => item.id === params.alternateId);
        if (!selected) throw new Error('Alternate transcript no longer exists.');
        const recordingStarted = entry.metrics.started;
        const previous = { id: randomUUID(), text: entry.text, ...(typeof entry.rawText === 'string' ? { rawText: entry.rawText } : {}), metrics: entry.metrics };
        entry.text = selected.text; entry.rawText = selected.rawText;
        entry.metrics = { ...selected.metrics, transcribedAt: selected.metrics.transcribedAt || selected.metrics.started, started: recordingStarted };
        entry.alternatives = [...alternatives.filter(item => item.id !== selected.id), previous];
        await saveEntry(entry); updateTrayMenu(); broadcastStats();
        return true;
      });
      case 'delete':
        if (busyEntries.has(params.id)) throw new Error('This transcript is being updated. Try again in a moment.');
        removeEntry(params.id); return true;
      // Retrying keeps the recording's original time, so it stays where it was in History and in the word counts.
      case 'retranscribe': return withEntry(params.id, async entry => {
        if (!entry.hasAudio) throw new Error('This transcript has no saved recording.');
        const requestedModel = entry.metrics?.requestedTranscriptionModel || entry.metrics?.transcriptionModel || settings.transcriptionModel || 'mai-transcribe-2-clean';
        const updated = testMode ? { id: entry.id, text: 'Retried transcript.', rawText: 'Retried transcript.', metrics: { ...entry.metrics, started: new Date().toISOString() } } : await transcribeSavedRecording(entry, requestedModel, true);
        entry.text = updated.text; entry.rawText = updated.rawText;
        entry.metrics = { ...updated.metrics, transcribedAt: updated.metrics.started, started: entry.metrics.started };
        await saveEntry(entry); updateTrayMenu(); broadcastStats();
        return true;
      });
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
  let startHidden = startupMode, lastDictationAt = 0, lastFocusSync = 0;
  // Installs a downloaded update. An automatic install relaunches hidden in the tray, as if Windows had started it.
  async function installUpdate(automatic = false) {
    if (updater.status.state !== 'ready' || quitting) return false;
    if (state.mode !== 'Idle') throw new Error('Finish dictating first, then restart to update.');
    if (automatic || !main.isVisible()) await fs.writeFile(hiddenRelaunchFile, '').catch(() => {});
    return updater.install();
  }
  updater.on('status', status => {
    broadcast({ type: 'update', update: status }); updateTrayMenu();
    if (status.state === 'ready' && !updateNotified) { updateNotified = true; if (!main?.isVisible()) notify(`Local Whisper ${status.version} is ready. It installs by itself when you step away, or restart now from the tray.`); }
  });
  let updateNotified = false;
  app.whenReady().then(async () => {
    if (!testMode) { await account.load(); await dictionarySync.load(); await itemSync.load(); await loadLearned(); }
    if (!testMode) {
      try { history = await historyStore.read(); costLedger = await historyStore.readCostLedger(); }
      catch (error) { historyError = true; log(`history read failed: ${error.message}`); }
      startHidden = startupMode || await fs.rm(hiddenRelaunchFile).then(() => true, () => false);
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
      updater.start();
      // A downloaded update installs by itself once you have stepped away: nothing recording, no dictation for a few
      // minutes and no keyboard or mouse input for five. "Restart now" in the app or tray installs it straight away.
      setInterval(() => {
        if (updater.status.state === 'ready' && state.mode === 'Idle' && Date.now() - lastDictationAt > 180000 && !main.isFocused() && powerMonitor.getSystemIdleTime() >= 300) installUpdate(true);
      }, 60000).unref();
      setInterval(() => { if (main.isVisible()) { refreshCredits(); broadcastStats(); } }, 60000).unref();
      main.on('focus', () => { if (state.mode === 'Idle' && Date.now() - lastFocusSync > 30000) { lastFocusSync = Date.now(); syncAccount().catch(() => {}); } });
    }
    if (!startHidden) main.show();
    if (testMode) await require('./tests/ui-smoke.cjs').run({ main, overlay, learning, app, engineEvent, testOverlayActions, updater });
  }).catch(error => { if (testMode) console.error(error); app.exit(1); });
}
