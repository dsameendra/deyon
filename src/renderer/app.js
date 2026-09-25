const KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'uploadSpeed',
  'connections', 'errorCode', 'errorMessage', 'dir', 'files', 'bittorrent'
];

let currentTab = 'all';
let settings = null;
let pickedFiles = []; // { name, base64, isTorrent, path? }
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[u]}`;
}

function fmtSpeed(n) { return `${fmtBytes(n)}/s`; }

function fmtEta(remaining, speed) {
  if (!speed || speed <= 0) return '—';
  const secs = remaining / speed;
  if (!isFinite(secs)) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function downloadName(item) {
  if (item.bittorrent && item.bittorrent.info && item.bittorrent.info.name) {
    return item.bittorrent.info.name;
  }
  if (item.files && item.files.length && item.files[0].path) {
    const p = item.files[0].path;
    const base = p.split(/[\\/]/).pop();
    if (base) return base;
  }
  if (item.files && item.files.length && item.files[0].uris && item.files[0].uris.length) {
    return item.files[0].uris[0].uri;
  }
  return item.gid;
}

function showToast(message, isError = false) {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ---------- Modal helpers ----------
function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

$$('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
$$('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});
$$('[data-external]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.deyon.openExternal(el.dataset.external);
  });
});

// ---------- Engine status ----------
function applyEngineStatus(status) {
  const dot = $('#engine-dot');
  const text = $('#engine-text');
  dot.classList.remove('ready', 'error');
  if (status.state === 'ready') {
    dot.classList.add('ready');
    text.textContent = 'Engine ready';
    startPolling();
  } else if (status.state === 'starting') {
    text.textContent = 'Starting engine…';
  } else if (status.state === 'restarting') {
    text.textContent = 'Applying settings…';
    stopPolling();
  } else if (status.state === 'error') {
    dot.classList.add('error');
    text.textContent = `Engine error: ${status.message}`;
  }
}

window.deyon.onEngineStatus(applyEngineStatus);
// The main process may have sent its first status before this listener was
// registered (webContents.send drops with no listener), so pull current
// state explicitly once on load.
window.deyon.getEngineStatus().then(applyEngineStatus);

// ---------- Tabs ----------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    renderList(lastSnapshot);
  });
});

// ---------- Polling & rendering ----------
let lastSnapshot = { active: [], waiting: [], stopped: [] };

function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, 1200);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  try {
    const [active, waiting, stopped, globalStat] = await window.deyon.aria2Multicall([
      { methodName: 'aria2.tellActive', params: [KEYS] },
      { methodName: 'aria2.tellWaiting', params: [0, 1000, KEYS] },
      { methodName: 'aria2.tellStopped', params: [0, 1000, KEYS] },
      { methodName: 'aria2.getGlobalStat', params: [] }
    ]);
    lastSnapshot = {
      active: active[0] || [],
      waiting: waiting[0] || [],
      stopped: stopped[0] || []
    };
    renderStats(globalStat[0] || {});
    renderList(lastSnapshot);
  } catch (err) {
    // engine likely restarting; ignore transient errors
  }
}

function renderStats(stat) {
  $('#stat-down').textContent = `↓ ${fmtSpeed(stat.downloadSpeed)}`;
  $('#stat-up').textContent = `↑ ${fmtSpeed(stat.uploadSpeed)}`;
  $('#stat-active').textContent = `${stat.numActive || 0} active`;
}

function classify(item) {
  if (item.status === 'error') return 'error';
  if (item.status === 'active' || item.status === 'paused') return 'active';
  if (item.status === 'waiting') return 'waiting';
  return 'stopped'; // complete / removed
}

const rowElements = new Map(); // gid -> row element

function renderList(snapshot) {
  const all = [...snapshot.active, ...snapshot.waiting, ...snapshot.stopped];
  let items = all;
  if (currentTab === 'active') items = all.filter((i) => i.status === 'active' || i.status === 'paused');
  if (currentTab === 'waiting') items = all.filter((i) => i.status === 'waiting');
  if (currentTab === 'stopped') items = all.filter((i) => i.status === 'complete');
  if (currentTab === 'error') items = all.filter((i) => i.status === 'error');

  const list = $('#list');
  const empty = $('#empty-state');

  if (items.length === 0) {
    for (const el of rowElements.values()) el.remove();
    rowElements.clear();
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  const seen = new Set();
  for (const item of items) {
    seen.add(item.gid);
    let row = rowElements.get(item.gid);
    if (!row) {
      row = createRow(item);
      rowElements.set(item.gid, row);
    }
    updateRow(row, item);
    list.appendChild(row); // moves existing nodes into order; doesn't recreate them
  }
  for (const [gid, el] of rowElements) {
    if (!seen.has(gid)) {
      el.remove();
      rowElements.delete(gid);
    }
  }
}

function withErrorToast(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      showToast(`Action failed: ${err.message}`, true);
    }
  };
}

function createRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-name"></div>
    <div class="row-actions"></div>
    <div class="row-meta"></div>
    <div class="row-progress"><div class="row-progress-fill"></div></div>
  `;
  row.dataset.gid = item.gid;
  row.dataset.status = '';
  return row;
}

function updateRow(row, item) {
  row._item = item; // always refresh so action handlers see current data (e.g. files[0].path)
  const total = Number(item.totalLength) || 0;
  const completed = Number(item.completedLength) || 0;
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : (item.status === 'complete' ? 100 : 0);
  const speed = Number(item.downloadSpeed) || 0;
  const name = downloadName(item);
  const statusLabel = {
    active: 'Downloading', waiting: 'Queued', paused: 'Paused',
    complete: 'Completed', error: 'Error', removed: 'Removed'
  }[item.status] || item.status;

  row.classList.toggle('status-error', item.status === 'error');

  const nameEl = row.querySelector('.row-name');
  if (nameEl.textContent !== name) {
    nameEl.textContent = name;
    nameEl.title = name;
  }

  const metaParts = [statusLabel, `${fmtBytes(completed)} / ${total ? fmtBytes(total) : '?'}`];
  if (item.status === 'active') {
    metaParts.push(fmtSpeed(speed), `ETA ${fmtEta(total - completed, speed)}`);
  }
  if (item.status === 'error') {
    metaParts.push(`Error ${item.errorCode || ''}: ${item.errorMessage || ''}`);
  }
  row.querySelector('.row-meta').textContent = metaParts.join('  ·  ');

  const fill = row.querySelector('.row-progress-fill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('done', item.status === 'complete');
  fill.classList.toggle('error', item.status === 'error');

  // Only rebuild the action buttons when the status actually changes, so an
  // in-flight click isn't invalidated by an unrelated poll tick.
  if (row.dataset.status !== item.status) {
    row.dataset.status = item.status;
    row.querySelector('.row-actions').replaceChildren(...buildActions(row));
  }
}

// Handlers read `row._item` at click time (not a captured `item`) since the
// row element persists across polls but its data keeps changing underneath.
function buildActions(row) {
  const buttons = [];
  const gid = row.dataset.gid;
  const status = row._item.status;

  buttons.push(actionButton('folder', 'Open folder', withErrorToast(async () => {
    const f = row._item.files && row._item.files[0];
    if (f && f.path) window.deyon.showInFolder(f.path);
  })));

  if (status === 'active') {
    buttons.push(actionButton('pause', 'Pause', withErrorToast(async () => {
      await window.deyon.aria2Call('pause', [gid]);
      poll();
    })));
  } else if (status === 'paused') {
    buttons.push(actionButton('play', 'Resume', withErrorToast(async () => {
      await window.deyon.aria2Call('unpause', [gid]);
      poll();
    })));
  }

  if (status === 'active' || status === 'paused' || status === 'waiting') {
    buttons.push(actionButton('remove', 'Remove', withErrorToast(async () => {
      await window.deyon.aria2Call('remove', [gid]);
      poll();
    })));
  } else {
    buttons.push(actionButton('remove', 'Clear', withErrorToast(async () => {
      await window.deyon.aria2Call('removeDownloadResult', [gid]);
      poll();
    })));
  }

  return buttons;
}

function actionButton(kind, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn-sm';
  btn.title = title;
  btn.textContent = { folder: 'Open', pause: 'Pause', play: 'Resume', remove: 'Remove' }[kind] || title;
  btn.addEventListener('click', onClick);
  return btn;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- Add Download modal ----------
$('#btn-add').addEventListener('click', () => {
  pickedFiles = [];
  $('#picked-files').innerHTML = '';
  $('#add-urls').value = '';
  $('#opt-dir').value = '';
  $('#opt-out').value = '';
  $('#opt-connections').value = '';
  $('#opt-split').value = '';
  $('#opt-speed-limit').value = '';
  $('#opt-referer').value = '';
  openModal('add-modal');
});

$('#btn-pick-dir').addEventListener('click', async () => {
  const dir = await window.deyon.chooseDirectory();
  if (dir) $('#opt-dir').value = dir;
});

$('#btn-pick-file').addEventListener('click', async () => {
  const files = await window.deyon.chooseTorrentFiles();
  addPickedFiles(files);
});

function addPickedFiles(files) {
  for (const f of files) {
    pickedFiles.push(f);
    const div = document.createElement('div');
    div.className = 'picked-file';
    div.textContent = `+ ${f.name}`;
    $('#picked-files').appendChild(div);
  }
}

const dropZone = $('#drop-zone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = [];
  for (const file of e.dataTransfer.files) {
    const p = window.deyon.getPathForFile(file);
    if (!p) continue;
    if (!/\.(torrent|metalink|meta4)$/i.test(p)) continue;
    const info = await window.deyon.readFileAsBase64(p);
    files.push(info);
  }
  if (files.length) addPickedFiles(files);
  else showToast('Drop a .torrent or .metalink file, or paste links in the text box instead.', true);
});

function buildPerDownloadOptions() {
  const opts = {};
  const dir = $('#opt-dir').value.trim();
  const out = $('#opt-out').value.trim();
  const conn = $('#opt-connections').value.trim();
  const split = $('#opt-split').value.trim();
  const speed = $('#opt-speed-limit').value.trim();
  const referer = $('#opt-referer').value.trim();
  if (dir) opts.dir = dir;
  if (out) opts.out = out;
  if (conn) opts['max-connection-per-server'] = conn;
  if (split) opts.split = split;
  if (speed) opts['max-download-limit'] = speed;
  if (referer) opts.referer = referer;
  return opts;
}

$('#btn-confirm-add').addEventListener('click', async () => {
  const raw = $('#add-urls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const opts = buildPerDownloadOptions();
  let addedCount = 0;

  try {
    for (const link of raw) {
      await window.deyon.aria2Call('addUri', [[link], opts]);
      addedCount++;
    }
    for (const file of pickedFiles) {
      if (file.isTorrent) {
        await window.deyon.aria2Call('addTorrent', [file.base64, [], opts]);
      } else {
        await window.deyon.aria2Call('addMetalink', [file.base64, opts]);
      }
      addedCount++;
    }
    if (addedCount === 0) {
      showToast('Add at least one link or file.', true);
      return;
    }
    closeModal('add-modal');
    poll();
    showToast(`Added ${addedCount} download${addedCount === 1 ? '' : 's'}.`);
  } catch (err) {
    showToast(`Failed to add download: ${err.message}`, true);
  }
});

// ---------- Settings modal ----------
$('#btn-settings').addEventListener('click', async () => {
  settings = await window.deyon.getSettings();
  fillSettingsForm(settings);
  $('#settings-hint').textContent = '';
  openModal('settings-modal');
});

function fillSettingsForm(s) {
  $('#s-downloadDir').value = s.downloadDir || '';
  $('#s-fileAllocation').value = s.fileAllocation;
  $('#s-maxConcurrentDownloads').value = s.maxConcurrentDownloads;
  $('#s-maxConnectionsPerServer').value = s.maxConnectionsPerServer;
  $('#s-split').value = s.split;
  $('#s-minSplitSize').value = s.minSplitSize;
  $('#s-maxOverallDownloadLimit').value = s.maxOverallDownloadLimit;
  $('#s-maxOverallUploadLimit').value = s.maxOverallUploadLimit;
  $('#s-maxTries').value = s.maxTries;
  $('#s-retryWait').value = s.retryWait;
  $('#s-userAgent').value = s.userAgent;
  $('#s-allProxy').value = s.allProxy;
  $('#s-checkCertificate').checked = !!s.checkCertificate;
  $('#s-continueDownload').checked = !!s.continueDownload;
  $('#s-enableDht').checked = !!s.enableDht;
  $('#s-btMaxPeers').value = s.btMaxPeers;
  $('#s-seedRatio').value = s.seedRatio;
  $('#s-seedTime').value = s.seedTime;
  $('#s-extraArgs').value = s.extraArgs || '';
}

$('#btn-pick-settings-dir').addEventListener('click', async () => {
  const dir = await window.deyon.chooseDirectory();
  if (dir) $('#s-downloadDir').value = dir;
});

$('#btn-save-settings').addEventListener('click', async () => {
  const updated = {
    downloadDir: $('#s-downloadDir').value.trim(),
    fileAllocation: $('#s-fileAllocation').value,
    maxConcurrentDownloads: Number($('#s-maxConcurrentDownloads').value) || 1,
    maxConnectionsPerServer: Number($('#s-maxConnectionsPerServer').value) || 1,
    split: Number($('#s-split').value) || 1,
    minSplitSize: $('#s-minSplitSize').value.trim() || '20M',
    maxOverallDownloadLimit: $('#s-maxOverallDownloadLimit').value.trim() || '0',
    maxOverallUploadLimit: $('#s-maxOverallUploadLimit').value.trim() || '0',
    maxTries: Number($('#s-maxTries').value) || 0,
    retryWait: Number($('#s-retryWait').value) || 0,
    userAgent: $('#s-userAgent').value.trim(),
    allProxy: $('#s-allProxy').value.trim(),
    checkCertificate: $('#s-checkCertificate').checked,
    continueDownload: $('#s-continueDownload').checked,
    enableDht: $('#s-enableDht').checked,
    btMaxPeers: Number($('#s-btMaxPeers').value) || 0,
    seedRatio: Number($('#s-seedRatio').value) || 0,
    seedTime: Number($('#s-seedTime').value) || 0,
    extraArgs: $('#s-extraArgs').value.trim()
  };

  $('#settings-hint').textContent = 'Saving…';
  try {
    const result = await window.deyon.saveSettings(updated);
    settings = { ...settings, ...updated };
    closeModal('settings-modal');
    showToast(result.restarted ? 'Settings saved — engine restarted to apply them.' : 'Settings saved.');
  } catch (err) {
    $('#settings-hint').textContent = `Failed to save: ${err.message}`;
  }
});

// Allow dropping links/files anywhere on the window to open the Add modal prefilled.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
