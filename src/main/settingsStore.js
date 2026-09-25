const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Keys that aria2 accepts via aria2.changeGlobalOption on a running engine
// (no restart needed). Everything else is baked in at aria2c launch time,
// so changing it requires restarting the engine process.
const LIVE_GLOBAL_KEYS = [
  'maxConcurrentDownloads',
  'maxOverallDownloadLimit',
  'maxOverallUploadLimit'
];

const DEFAULTS = {
  downloadDir: '',
  maxConcurrentDownloads: 5,
  maxConnectionsPerServer: 4,
  split: 5,
  minSplitSize: '20M',
  continueDownload: true,
  maxOverallDownloadLimit: '0',
  maxOverallUploadLimit: '0',
  maxTries: 5,
  retryWait: 0,
  userAgent: '',
  allProxy: '',
  seedRatio: 1.0,
  seedTime: 0,
  enableDht: true,
  btMaxPeers: 55,
  checkCertificate: true,
  fileAllocation: 'prealloc',
  extraArgs: ''
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    return { ...DEFAULTS, downloadDir: app.getPath('downloads') };
  }
}

function save(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
}

function diffRequiresRestart(oldSettings, newSettings) {
  return Object.keys(newSettings).some((key) => {
    if (LIVE_GLOBAL_KEYS.includes(key)) return false;
    return oldSettings[key] !== newSettings[key];
  });
}

module.exports = { DEFAULTS, LIVE_GLOBAL_KEYS, load, save, diffRequiresRestart };
