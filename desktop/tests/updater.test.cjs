const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { isInstalledWindowsApp } = require('../updater.cjs');

test('only a Windows NSIS installation checks for updates', () => {
  const exePath = path.join('C:', 'Apps', 'LocalWhisper.exe');
  const found = [];
  const existsSync = file => { found.push(file); return true; };
  const options = { platform: 'win32', exePath, existsSync };

  assert.equal(isInstalledWindowsApp({ isPackaged: false }, options), false);
  assert.equal(isInstalledWindowsApp({ isPackaged: true }, { ...options, platform: 'linux' }), false);
  assert.equal(found.length, 0);
  assert.equal(isInstalledWindowsApp({ isPackaged: true }, options), true);
  assert.equal(path.basename(found[0]), 'Uninstall LocalWhisper.exe');
  assert.equal(isInstalledWindowsApp({ isPackaged: true }, { ...options, existsSync: () => false }), false);
});

test('reports download progress and installs only a downloaded update', async () => {
  const { EventEmitter } = require('node:events');
  const { Updater } = require('../updater.cjs');
  const fake = Object.assign(new EventEmitter(), { checks: 0, installs: [], checkForUpdates() { this.checks++; return Promise.resolve(); }, quitAndInstall(...args) { this.installs.push(args); } });
  const updater = new Updater({ getVersion: () => '0.4.1', isPackaged: true }, { updater: fake, supported: true });
  const seen = []; updater.on('status', status => seen.push(status.state));
  updater.start();
  assert.equal(updater.install(), false, 'nothing to install yet');
  fake.emit('checking-for-update'); fake.emit('update-available', { version: '0.4.2' }); fake.emit('download-progress', { percent: 41.6 });
  assert.deepEqual([updater.status.state, updater.status.version, updater.status.progress], ['downloading', '0.4.2', 42]);
  fake.emit('update-downloaded', { version: '0.4.2' });
  fake.emit('error', new Error('a later check failed'));
  assert.equal(updater.status.state, 'ready', 'a failed later check does not hide a ready update');
  await updater.check(); assert.equal(fake.checks, 0, 'no checking once an update is ready');
  assert.equal(updater.install(), true);
  assert.deepEqual(fake.installs, [[true, true]]);
  assert.deepEqual(seen, ['checking', 'downloading', 'downloading', 'ready']);
  const unsupported = new Updater({ getVersion: () => '0.4.1', isPackaged: false });
  assert.equal(unsupported.status.state, 'unsupported');
});
