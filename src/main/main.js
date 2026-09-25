const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Aria2Manager } = require('./aria2Manager');
const settingsStore = require('./settingsStore');

let mainWindow = null;
let aria2 = null;
let currentSettings = null;
let engineStatus = { state: 'starting' };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'Deyon',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendEngineStatus(status) {
  engineStatus = status;
  if (mainWindow) {
    mainWindow.webContents.send('engine:status', status);
  }
}

async function startEngine() {
  currentSettings = settingsStore.load();
  if (!currentSettings.downloadDir) {
    currentSettings.downloadDir = app.getPath('downloads');
    settingsStore.save(currentSettings);
  }

  aria2 = new Aria2Manager();
  sendEngineStatus({ state: 'starting' });
  try {
    await aria2.start(currentSettings);
    sendEngineStatus({ state: 'ready' });
  } catch (err) {
    sendEngineStatus({ state: 'error', message: err.message });
  }
}

function registerIpcHandlers() {
  ipcMain.handle('aria2:call', async (_event, method, params) => {
    return aria2.call(method, params || []);
  });

  ipcMain.handle('aria2:multicall', async (_event, calls) => {
    return aria2.multicall(calls || []);
  });

  ipcMain.handle('settings:get', () => currentSettings);

  ipcMain.handle('settings:save', async (_event, newSettings) => {
    const merged = { ...currentSettings, ...newSettings };
    const needsRestart = settingsStore.diffRequiresRestart(currentSettings, merged);
    settingsStore.save(merged);
    currentSettings = merged;

    if (needsRestart) {
      sendEngineStatus({ state: 'restarting' });
      try {
        await aria2.restart(currentSettings);
        sendEngineStatus({ state: 'ready' });
      } catch (err) {
        sendEngineStatus({ state: 'error', message: err.message });
        throw err;
      }
    } else {
      try {
        await aria2.call('changeGlobalOption', [
          {
            'max-concurrent-downloads': String(merged.maxConcurrentDownloads),
            'max-overall-download-limit': String(merged.maxOverallDownloadLimit),
            'max-overall-upload-limit': String(merged.maxOverallUploadLimit)
          }
        ]);
      } catch (err) {
        // non-fatal: values still take effect after next restart
      }
    }
    return { ok: true, restarted: needsRestart };
  });

  ipcMain.handle('dialog:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:choose-torrent-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }]
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      name: path.basename(filePath),
      path: filePath,
      isTorrent: filePath.toLowerCase().endsWith('.torrent'),
      base64: fs.readFileSync(filePath).toString('base64')
    }));
  });

  ipcMain.handle('file:read-base64', async (_event, filePath) => {
    const buf = fs.readFileSync(filePath);
    return {
      name: path.basename(filePath),
      isTorrent: filePath.toLowerCase().endsWith('.torrent'),
      base64: buf.toString('base64')
    };
  });

  ipcMain.handle('shell:show-in-folder', async (_event, filePath) => {
    shell.showItemInFolder(path.normalize(filePath));
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('engine:get-status', () => engineStatus);

  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    downloadsPath: app.getPath('downloads')
  }));
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();
  await startEngine();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (aria2 && aria2.ready) {
    event.preventDefault();
    await aria2.stop();
    app.exit(0);
  }
});
