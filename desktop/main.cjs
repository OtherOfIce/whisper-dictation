const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, clipboard, safeStorage, dialog, Notification } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectTimings } = require('./model.cjs');
const { HistoryStore } = require('./history-store.cjs');
const { getWordStats } = require('./stats.cjs');
const { readWisprDictionary } = require('./wispr-dictionary.cjs');
const testMode = process.argv.includes('--ui-test');
const startupMode = process.argv.includes('--startup');
app.setName('Local Whisper');
if (testMode) app.setPath('userData', path.join(app.getPath('temp'), 'local-whisper-ui-test'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let main, overlay, tray, engine, quitting = false, state = { mode: 'Idle' }, history = [], historyError = false;
  const testOverlayActions = [];
  let nextId = 0, settings = {}, balance = null, refreshPromise, saveQueue = Promise.resolve();
  const pending = new Map();
  const historyPath = () => path.join(app.getPath('userData'), 'history.sqlite');
  const historyStore = new HistoryStore(historyPath(), safeStorage, path.join(app.getPath('userData'), 'history.bin'));
  const broadcast = value => { for (const win of [main, overlay]) if (win && !win.isDestroyed()) win.webContents.send('event', value); };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!engine || engine.killed || !engine.stdin.writable) return reject(new Error('Dictation engine is unavailable. Restart the app.'));
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('The request timed out. Please try again.')); }, 16000);
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
  function persist(audioById) {
    if (testMode) return;
    if (historyError) { notify('Could not save history. Your current transcripts are still available in this window.'); return; }
    saveQueue = historyStore.write(history, audioById);
    saveQueue.catch(() => notify('Could not save history. Your current transcripts are still available in this window.'));
  }
  function showMain(view = 'history') { main.show(); main.focus(); broadcast({ type: 'navigate', view }); }
  function engineEvent(event) {
    if (event.type === 'reply') {
      const request = pending.get(event.id);
      if (request) { clearTimeout(request.timeout); pending.delete(event.id); event.error ? request.reject(new Error(event.error)) : request.resolve(event.result); }
      return;
    }
    if (event.type === 'ready') { settings = event.settings; refreshCredits(); }
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
        if (!overlay.isVisible()) overlay.showInactive();
      }
    }
    if (event.type === 'transcript') {
      const { audio, audioFormat, ...rest } = event.entry;
      const recording = typeof audio === 'string' ? Buffer.from(audio, 'base64') : null;
      const entry = { ...rest, hasAudio: recording !== null };
      history.unshift(entry);
      persist(recording ? new Map([[entry.id, { bytes: recording, format: audioFormat || 'wav' }]]) : undefined);
      refreshCredits(); broadcast({ type: 'stats', stats: getWordStats(history) });
      event = { ...event, entry };
    }
    if (event.type === 'metricsUpdated') {
      const entry = history.find(x => x.id === event.id);
      if (entry) { entry.metrics = event.metrics; persist(); }
    }
    if (event.type === 'needsSettings') showMain('settings');
    if (event.type === 'notice') { notify(event.message); return; }
    broadcast(event);
  }
  async function refreshCredits() {
    if (testMode) return balance;
    if (refreshPromise) return refreshPromise;
    refreshPromise = send('credits').then(value => { balance = value; broadcast({ type: 'balance', balance }); return balance; })
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
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    if (!isMain && !isOverlay) throw new Error('Unknown window.');
    if (isOverlay) {
      if (method === 'initial') return { state };
      if (!['cancel', 'finish'].includes(method)) throw new Error('Unknown toolbar action.');
      if (testMode) { testOverlayActions.push(method); return null; }
      return send(method, method === 'finish' ? { fromOverlay: true } : {});
    }
    switch (method) {
      case 'initial': return { history, settings, balance, state, historyError, stats: getWordStats(history) };
      case 'refreshCredits': return refreshCredits();
      case 'setLockMode': {
        if (!params || typeof params.lockMode !== 'boolean') throw new Error('Invalid settings.');
        settings = testMode ? { ...settings, lockMode: params.lockMode } : await send('setLockMode', params);
        broadcast({ type: 'settings', settings }); return settings;
      }
      case 'saveSettings': {
        if (!params || typeof params.liveChunks !== 'boolean' || typeof params.lockMode !== 'boolean' || ['apiKey', 'balanceKey'].some(k => params[k] != null && (typeof params[k] !== 'string' || params[k].length > 1024))) throw new Error('Invalid settings.');
        if (!['gpt-transcribe', 'mai-transcribe-2-verbatim', 'mai-transcribe-2-clean'].includes(params.transcriptionModel)) throw new Error('Invalid transcription model.');
        if (!['off', 'luna', 'luna-fast'].includes(params.cleanupMode)) throw new Error('Invalid cleanup mode.');
        validateDictionaryTerms(params.dictionaryTerms);
        settings = testMode ? { ...settings, liveChunks: params.liveChunks, lockMode: params.lockMode, transcriptionModel: params.transcriptionModel, cleanupMode: params.cleanupMode, dictionaryTerms: params.dictionaryTerms } : await send('saveSettings', params);
        broadcast({ type: 'settings', settings }); refreshCredits(); return settings;
      }
      case 'importWisprDictionary': {
        validateDictionaryTerms(params.dictionaryTerms);
        const imported = testMode
          ? { terms: ['Wispr Flow', 'Astra'], skippedSnippets: 3, convertedReplacements: 1 }
          : readWisprDictionary(path.join(app.getPath('appData'), 'Wispr Flow', 'flow.sqlite'));
        const before = new Set(params.dictionaryTerms.map(term => term.trim().toLocaleLowerCase()).filter(Boolean)).size;
        const dictionaryTerms = mergeDictionaryTerms(params.dictionaryTerms, imported.terms);
        settings = testMode ? { ...settings, dictionaryTerms } : await send('saveDictionary', { dictionaryTerms });
        return { settings, added: dictionaryTerms.length - before, ...imported };
      }
      case 'copy': {
        const entry = history.find(x => x.id === params.id); if (!entry) throw new Error('Transcript no longer exists.');
        await clipboard.writeText(entry.text); return true;
      }
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
      case 'delete': history = history.filter(x => x.id !== params.id); await saveHistory(); broadcast({ type: 'history', history }); broadcast({ type: 'stats', stats: getWordStats(history) }); return true;
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
    if (!testMode) {
      try { history = await historyStore.read(); }
      catch { historyError = true; }
    } else {
      ({ history, settings, balance } = require('./tests/fixtures.cjs'));
    }
    const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
    main = new BrowserWindow({ width: 1220, height: 820, minWidth: 850, minHeight: 600, frame: false, backgroundColor: '#f5f4f0', show: false, webPreferences });
    main.on('close', event => { if (!quitting) { event.preventDefault(); main.hide(); } });
    overlay = new BrowserWindow({ width: 192, height: 56, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, webPreferences });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(true);
    if (testMode) for (const win of [main, overlay]) win.webContents.on('console-message', event => console.log('renderer:', event.message));
    await Promise.all([secure(main, 'index.html'), secure(overlay, 'overlay.html')]);
    if (!testMode) {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
      tray = new Tray(icon); tray.setToolTip('Local Whisper');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Local Whisper', click: () => showMain() }, { label: 'Settings', click: () => showMain('settings') }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
      tray.on('double-click', () => showMain());
      startEngine();
      setInterval(() => { if (main.isVisible()) { refreshCredits(); broadcast({ type: 'stats', stats: getWordStats(history) }); } }, 60000).unref();
    }
    if (!startupMode) main.show();
    if (testMode) await require('./tests/ui-smoke.cjs').run({ main, overlay, app, engineEvent, testOverlayActions });
  }).catch(error => { if (testMode) console.error(error); app.exit(1); });
}
