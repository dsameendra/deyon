const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deyon', {
  aria2Call: (method, params) => ipcRenderer.invoke('aria2:call', method, params),
  aria2Multicall: (calls) => ipcRenderer.invoke('aria2:multicall', calls),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  chooseTorrentFiles: () => ipcRenderer.invoke('dialog:choose-torrent-files'),
  readFileAsBase64: (filePath) => ipcRenderer.invoke('file:read-base64', filePath),

  showInFolder: (filePath) => ipcRenderer.invoke('shell:show-in-folder', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  onEngineStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('engine:status', listener);
    return () => ipcRenderer.removeListener('engine:status', listener);
  }
});
