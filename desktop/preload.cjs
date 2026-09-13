const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('whisper', {
  call: (method, params) => ipcRenderer.invoke('command', method, params),
  onEvent: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
});
