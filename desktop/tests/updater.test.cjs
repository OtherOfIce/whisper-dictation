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
