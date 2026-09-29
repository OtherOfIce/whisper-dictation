const fs = require('node:fs');
const path = require('node:path');

function isInstalledWindowsApp(app, { platform = process.platform, exePath = process.execPath, existsSync = fs.existsSync } = {}) {
  return platform === 'win32' && app.isPackaged && existsSync(path.join(path.dirname(exePath), 'Uninstall LocalWhisper.exe'));
}

function startAutoUpdates(app, onDownloaded) {
  if (!isInstalledWindowsApp(app)) return;

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('update-downloaded', ({ version }) => onDownloaded(version));
  autoUpdater.on('error', error => console.warn('Update check failed:', error.message));

  // The quit handler installs a downloaded update after the engine and history have shut down.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000).unref();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

module.exports = { isInstalledWindowsApp, startAutoUpdates };
