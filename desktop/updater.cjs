const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function isInstalledWindowsApp(app, { platform = process.platform, exePath = process.execPath, existsSync = fs.existsSync } = {}) {
  return platform === 'win32' && app.isPackaged && existsSync(path.join(path.dirname(exePath), 'Uninstall LocalWhisper.exe'));
}

const CHECK_INTERVAL = 2 * 60 * 60 * 1000;

// Downloads updates in the background and reports one status the UI can show:
//   unsupported | idle | checking | downloading | ready | error
// `install()` restarts into the downloaded version. Main decides when that is safe (see main.cjs).
class Updater extends EventEmitter {
  constructor(app, { updater = null, supported = isInstalledWindowsApp(app) } = {}) {
    super();
    this.app = app; this.supported = supported; this.autoUpdater = updater;
    this.status = { state: supported ? 'idle' : 'unsupported', current: app.getVersion(), version: null, progress: null, error: null, checkedAt: null };
  }
  set(changes) { this.status = { ...this.status, ...changes }; this.emit('status', this.status); }
  start() {
    if (!this.supported) return;
    this.autoUpdater ??= require('electron-updater').autoUpdater;
    const updater = this.autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => { if (this.status.state !== 'ready') this.set({ state: 'checking', error: null }); });
    updater.on('update-not-available', () => { if (this.status.state !== 'ready') this.set({ state: 'idle', checkedAt: Date.now() }); });
    updater.on('update-available', ({ version }) => this.set({ state: 'downloading', version, progress: 0, checkedAt: Date.now() }));
    updater.on('download-progress', ({ percent }) => this.set({ state: 'downloading', progress: Math.round(percent) }));
    updater.on('update-downloaded', ({ version }) => this.set({ state: 'ready', version, progress: 100 }));
    updater.on('error', error => { if (this.status.state !== 'ready') this.set({ state: 'error', error: error?.message || 'Update check failed', checkedAt: Date.now() }); });
    setTimeout(() => this.check(), 15000).unref();
    setInterval(() => this.check(), CHECK_INTERVAL).unref();
  }
  check() {
    if (!this.supported || !this.autoUpdater || ['checking', 'downloading', 'ready'].includes(this.status.state)) return Promise.resolve(this.status);
    return this.autoUpdater.checkForUpdates().then(() => this.status, () => this.status);
  }
  // Quits (through the app's normal shutdown, which saves history and stops the engine) and installs silently,
  // then starts the new version.
  install() {
    if (this.status.state !== 'ready') return false;
    this.autoUpdater.quitAndInstall(true, true);
    return true;
  }
}

module.exports = { isInstalledWindowsApp, Updater };
