const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { clipboard } = require('electron');

// Drives the real windows with demo fixtures; no engine and no network. Screenshots go to desktop/artifacts.
exports.run = async ({ main, overlay, learning, app, engineEvent, testOverlayActions, updater }) => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => main.webContents.executeJavaScript(code);
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const visible = id => evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden && !document.getElementById(${JSON.stringify(id)}).closest('[hidden]')`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settings = () => evaluate("window.whisper.call('initial').then(x => x.settings)");
  const directory = path.join(__dirname, '..', 'artifacts'); await fs.mkdir(directory, { recursive: true });
  const shot = async (name, win = main) => { await wait(150); return fs.writeFile(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const { history } = require('./fixtures.cjs');
  main.setSize(1280, 820); await wait(300);

  // Home: stats, recent list, shortcut keycaps.
  history[0].alternatives = [{ id: 'alternate-gpt', text: 'An alternate GPT transcript.', rawText: 'An alternate GPT transcript.', metrics: { ...history[0].metrics, started: new Date(Date.parse(history[0].metrics.started) + 60000).toISOString(), costs: [], transcriptionModel: 'gpt-transcribe', cleanupMode: 'off' } }];
  engineEvent({ type: 'history', history }); await wait(300);
  assert.equal(await evaluate('document.querySelectorAll("#recent-list .transcript").length'), 4);
  assert.equal(await text('stat-words'), '83');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#shortcut-keys .keycap")].map(k => k.textContent)'), ['Ctrl', 'Win']);
  assert.equal(await visible('setup-card'), false);
  await shot('home');

  // History: day groups, copy, search highlighting, failed transcript with Retry.
  await click('[data-view=history]'); await wait(100);
  assert.equal(await evaluate('document.querySelectorAll("#history-list .transcript").length'), 4);
  assert.equal(await evaluate('document.querySelector("#history-list .day-label").textContent'), 'Today');
  const previousClipboard = (await clipboard.readText());
  await evaluate(`document.querySelector('#history-list [data-id="demo-1"] [aria-label="Copy transcript"]').click()`); await wait(100);
  assert.equal((await clipboard.readText()), history[1].text);
  await evaluate('document.getElementById("search").value="tomorrow"; document.getElementById("search").dispatchEvent(new Event("input"))'); await wait(250);
  assert.equal(await evaluate('document.querySelectorAll("#history-list .transcript").length'), 1);
  assert.equal(await evaluate('document.querySelector("#history-list mark").textContent'), 'tomorrow');
  await evaluate('document.getElementById("search").value=""; document.getElementById("search").dispatchEvent(new Event("input"))'); await wait(250);
  const started = new Date(Date.now() - 2 * 86400000).toISOString();
  engineEvent({ type: 'transcript', entry: { id: 'failed', text: '', audio: 'UklGRg==', audioFormat: 'wav', metrics: { ...history[0].metrics, started, outcome: 'Timed out' } } }); await wait(100);
  assert.equal(await evaluate('document.querySelector("[data-id=failed] .retry-button") !== null'), true);
  await click('#history-list [data-id=failed] .retry-button'); await wait(150);
  const retried = await evaluate("window.whisper.call('initial').then(x => x.history.find(e => e.id === 'failed'))");
  assert.equal(retried.text, 'Retried transcript.');
  assert.equal(retried.metrics.started, started, 'retry keeps the original recording time');
  assert.equal(await evaluate('document.querySelector("#history-list [data-id=failed] .retry-button")'), null);
  await shot('history');

  // Row menu: delete hides at once and Undo brings it back; letting the toast expire deletes for real.
  const openMenu = id => evaluate(`document.querySelector('#history-list [data-id="${id}"] [aria-label="More actions"]').click()`);
  const menuItem = label => evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);
  await openMenu('demo-3'); await wait(50);
  assert.equal(await evaluate('document.querySelectorAll(".menu button").length'), 5);
  await shot('history-menu');
  await menuItem('Delete'); await wait(50);
  assert.equal(await evaluate('document.querySelector("#history-list [data-id=demo-3]")'), null);
  await click('#toast-action'); await wait(50);
  assert.notEqual(await evaluate('document.querySelector("#history-list [data-id=demo-3]")'), null);
  await openMenu('demo-3'); await wait(50); await menuItem('Delete'); await wait(6300);
  assert.equal((await evaluate("window.whisper.call('initial').then(x => x.history.map(e => e.id))")).includes('demo-3'), false);

  // Details drawer, including streaming diagnostics and the original text before cleanup.
  await openMenu('demo-0'); await wait(50); await menuItem('Timing details'); await wait(200);
  assert.equal(await text('latency-value'), '1.36 s');
  assert.equal(await evaluate('document.querySelectorAll("[data-stage=Recording]").length'), 0);
  engineEvent({ type: 'metricsUpdated', id: 'demo-0', metrics: { ...history[0].metrics, streamingAttempts: [{ model: 'microsoft/mai-transcribe-2-streaming', startedMs: 0, connectedMs: 100, firstTranscriptMs: 400, lastTranscriptMs: 18000, transcriptEvents: 20, inputCompletedMs: 18432, endedMs: 48432, outcome: 'Failed', failureStage: 'finalize' }] } });
  await wait(150);
  assert((await text('timing-facts')).includes('Failed while waiting for the completed transcript'));
  await click('#include-recording'); await wait(100);
  assert.equal(await evaluate('document.querySelectorAll("[data-stage=Recording]").length'), 1);
  await shot('performance');
  await click('#close-drawer');

  // Compare: alternates, make primary keeps the recording time.
  await openMenu('demo-0'); await wait(50); await menuItem('Compare'); await wait(100);
  assert.equal(await evaluate('document.querySelectorAll(".transcript-version").length'), 2);
  await evaluate('document.getElementById("alternate-model").value="mai-transcribe-2-verbatim"; document.getElementById("create-alternate").click()'); await wait(200);
  assert.equal(await evaluate('document.querySelectorAll(".transcript-version").length'), 3);
  await shot('comparison');
  await click('[data-alternate-id="alternate-gpt"] [data-action="make-primary"]'); await wait(150);
  const promoted = await evaluate("window.whisper.call('initial').then(x => x.history.find(e => e.id === 'demo-0'))");
  assert.equal(promoted.text, 'An alternate GPT transcript.');
  assert.equal(promoted.metrics.started, history[0].metrics.started);
  await click('#close-comparison');

  // Paste fallback copies to the clipboard.
  await clipboard.writeText('sentinel');
  engineEvent({ type: 'transcript', entry: { id: 'pasted-ok', text: 'Pasted into the focused field.', metrics: { ...history[0].metrics, outcome: 'Pasted' } } }); await wait(80);
  assert.equal((await clipboard.readText()), 'sentinel');
  engineEvent({ type: 'transcript', entry: { id: 'focus-lost', text: 'Focus moved before paste.', metrics: { ...history[0].metrics, outcome: 'Saved to history' } } }); await wait(80);
  assert.equal((await clipboard.readText()), 'Focus moved before paste.');
  assert.equal(await evaluate("window.whisper.call('copyLast')"), true);
  await clipboard.writeText(previousClipboard);

  // Settings save as soon as they change.
  await click('#open-settings'); await wait(100);
  assert.equal(await visible('settings-modal'), true);
  await click('#lock-mode'); await wait(100);
  assert.equal((await settings()).lockMode, false);
  assert.match(await text('shortcut-description'), /Hold/);
  await click('#lock-mode'); await wait(100);
  assert.equal((await settings()).lockMode, true);
  await click('#rebind-shortcut'); await wait(50);
  engineEvent({ type: 'shortcutCaptured', shortcut: { modifiers: 6, key: 68 } }); await wait(150);
  assert.deepEqual((await settings()).shortcut, { modifiers: 6, key: 68 });
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#shortcut-keys .keycap")].map(k => k.textContent)'), ['Ctrl', 'Shift', 'D']);
  await click('#rebind-shortcut'); await wait(50);
  engineEvent({ type: 'shortcutCaptured', shortcut: { modifiers: 0, key: 68 } }); await wait(80);
  assert.deepEqual((await settings()).shortcut, { modifiers: 6, key: 68 }, 'an invalid capture is not saved');
  await click('#reset-shortcut'); await wait(150);
  assert.deepEqual((await settings()).shortcut, { modifiers: 10, key: 0 });
  await click('#test-microphone'); await wait(50);
  engineEvent({ type: 'microphoneTestLevel', level: 0.6, seconds: 1.2 }); await wait(50);
  assert.equal(await evaluate('document.getElementById("microphone-test-level").value'), 0.6);
  const testWav = Buffer.alloc(364); testWav.write('RIFF'); testWav.writeUInt32LE(356, 4); testWav.write('WAVEfmt ', 8); testWav.writeUInt32LE(16, 16); testWav.writeUInt16LE(1, 20); testWav.writeUInt16LE(1, 22); testWav.writeUInt32LE(16000, 24); testWav.writeUInt32LE(32000, 28); testWav.writeUInt16LE(2, 32); testWav.writeUInt16LE(16, 34); testWav.write('data', 36); testWav.writeUInt32LE(320, 40);
  engineEvent({ type: 'microphoneTestStopped', audio: testWav.toString('base64') }); await wait(50);
  assert.equal(await evaluate('document.getElementById("play-microphone-test").disabled'), false);
  await evaluate("document.getElementById('microphone-device').value='usb-mic'; document.getElementById('microphone-device').dispatchEvent(new Event('change'))"); await wait(150);
  assert.equal((await settings()).microphoneDeviceId, 'usb-mic');
  assert.equal(await evaluate('document.getElementById("play-microphone-test").disabled'), true, 'switching microphones discards the test');
  await shot('settings-general');

  await click('[data-tab=transcription]'); await wait(50);
  for (const model of ['mai-transcribe-2-verbatim', 'gpt-transcribe', 'mai-transcribe-2-streaming', 'mai-transcribe-2-clean']) {
    await evaluate(`document.getElementById('transcription-model').value=${JSON.stringify(model)}; document.getElementById('transcription-model').dispatchEvent(new Event('change'))`); await wait(120);
    assert.equal((await settings()).transcriptionModel, model);
    if (model === 'mai-transcribe-2-streaming') assert.equal(await evaluate('document.getElementById("live-chunks").disabled'), true);
  }
  for (const mode of ['luna', 'off']) {
    await evaluate(`document.getElementById('cleanup-mode').value='${mode}'; document.getElementById('cleanup-mode').dispatchEvent(new Event('change'))`); await wait(120);
    assert.equal((await settings()).cleanupMode, mode);
  }
  await click('[data-tab=keys]'); await wait(50);
  await evaluate("document.getElementById('xai-api-key').value='xai-test-only'"); await click('[data-save-key=xaiApiKey]'); await wait(150);
  assert.equal((await settings()).hasXaiKey, true);
  assert.equal(await evaluate('document.getElementById("xai-api-key").value'), '');
  assert.equal(await text('xai-key-status'), 'Saved');
  assert.equal(await visible('xai-api-key'), false, 'a saved key collapses to Replace');
  await evaluate("document.getElementById('management-key').value='test-management-key'"); await click('#import-costs'); await wait(150);
  assert.equal(await evaluate('document.getElementById("management-key").value'), '');
  assert.match(await text('cost-voice'), /^\$0\.0\d\d$/);
  await shot('settings-keys');

  // Sync: turn on shows the recovery key, link shows a code, turn off needs a second click.
  await click('[data-tab=sync]'); await wait(50);
  assert.equal(await visible('sync-off'), true);
  await click('#sync-turn-on'); await wait(200);
  assert.equal(await visible('sync-on'), true);
  assert.equal(await text('recovery-key'), 'TEST1-TEST2-ABCDE-FGHJK-MNPQR-STVWX');
  assert.equal(await evaluate('document.querySelectorAll("#device-list li").length'), 2);
  await click('#link-device'); await wait(150);
  assert.equal(await text('link-code'), 'K7Q2-9XMB-4TRD');
  await shot('settings-sync');
  await click('#link-done'); await click('#sync-sign-out'); await wait(50);
  assert.equal(await visible('sync-on'), true);
  await click('#sync-sign-out'); await wait(150);
  assert.equal(await visible('sync-off'), true);

  // Updates: a downloaded update shows in the sidebar and in About.
  await click('[data-tab=about]'); await wait(50);
  assert.equal(await visible('update-card'), false);
  updater.set({ state: 'ready', version: '9.9.9', progress: 100 }); await wait(100);
  assert.equal(await visible('update-card'), true);
  assert.equal(await visible('about-install'), true);
  assert.match(await text('update-status'), /9\.9\.9 is ready/);
  await shot('settings-about');
  await click('[data-close-settings]'); await wait(50);
  assert.equal(await visible('settings-modal'), false);

  // Dictionary: add, remove with undo, learned words marked, Wispr import.
  await click('[data-view=dictionary]'); await click('#dictionary-add-open');
  await evaluate("document.getElementById('dictionary-new-term').value='Acme Corp, Maya\\'s project'; document.getElementById('dictionary-add').requestSubmit()"); await wait(150);
  assert.deepEqual((await settings()).dictionaryTerms, ['Acme Corp', "Maya's project"]);
  await evaluate(`[...document.querySelectorAll('.term')].find(t => t.textContent.includes('Acme')).querySelector('button').click()`); await wait(150);
  assert.deepEqual((await settings()).dictionaryTerms, ["Maya's project"]);
  await click('#toast-action'); await wait(150);
  assert.deepEqual((await settings()).dictionaryTerms, ["Maya's project", 'Acme Corp']);
  const learnedSettings = { ...(await settings()), dictionaryTerms: ["Maya's project", 'Acme Corp', 'Raikage'] };
  engineEvent({ type: 'dictionaryLearned', id: 'learned-test', term: 'Raikage', settings: learnedSettings }); await wait(150);
  assert.equal(await evaluate('document.querySelectorAll(".term .learned").length'), 1);
  await click('[data-dictionary-filter=learned]'); await wait(50);
  assert.equal(await evaluate('document.querySelectorAll(".term").length'), 1);
  await click('[data-dictionary-filter=all]');
  assert.equal(learning.isVisible(), true);
  assert.equal(await learning.webContents.executeJavaScript('document.querySelector(".term")?.textContent ?? "missing"'), 'Raikage');
  await shot('learning-toast', learning);
  await learning.webContents.executeJavaScript('document.querySelector("button").click()'); await wait(150);
  assert.equal(await evaluate('document.querySelectorAll(".term .learned").length'), 0);
  await click('#import-wispr'); await wait(150);
  assert((await settings()).dictionaryTerms.includes('Wispr Flow'));
  await shot('dictionary');

  // Engine offline banner, and setup prompt without a key.
  engineEvent({ type: 'engineOffline' }); await wait(50);
  assert.equal(await visible('engine-banner'), true);
  engineEvent({ type: 'ready', settings: { ...(await settings()), hasKey: false } }); await wait(50);
  assert.equal(await visible('engine-banner'), false);
  await click('[data-view=home]'); await wait(50);
  assert.equal(await visible('setup-card'), true);
  await shot('home-setup');

  // Recording overlay: text-free, not focusable, lock-mode buttons work.
  assert(!overlay.isVisible());
  engineEvent({ type: 'state', mode: 'PushToTalk', level: .18 }); await wait(200);
  assert(overlay.isVisible());
  assert.equal(overlay.isFocusable(), false);
  assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll(".bar").length'), 10);
  assert.equal(await overlay.webContents.executeJavaScript('document.body.innerText'), '');
  engineEvent({ type: 'state', mode: 'Busy', phase: 'transcribing', level: 0 }); await wait(250);
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("wave").className'), 'wave transcribing');
  engineEvent({ type: 'state', mode: 'LockMode', level: .18 }); await wait(100);
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("finish").hidden'), false);
  const finishPoint = await overlay.webContents.executeJavaScript('(() => { const r = document.getElementById("finish").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
  overlay.webContents.sendInputEvent({ type: 'mouseDown', ...finishPoint, button: 'left', clickCount: 1 });
  overlay.webContents.sendInputEvent({ type: 'mouseUp', ...finishPoint, button: 'left', clickCount: 1 });
  await wait(50);
  assert.deepEqual(testOverlayActions, ['finish']);
  await shot('overlay', overlay);
  engineEvent({ type: 'state', mode: 'Idle', level: 0 }); assert(!overlay.isVisible());

  // Narrow window still lays out.
  main.setSize(900, 640); await wait(300);
  assert(await evaluate('document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth + 1'));
  await shot('narrow');
  console.log('PASS: Electron home, history, dictionary, settings, sync, updates and recording overlay');
  app.quit();
};
