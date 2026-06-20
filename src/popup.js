/**
 * API Reverse Engineer — Popup Logic
 */

const btnRecord = document.getElementById('btnRecord');
const btnDownload = document.getElementById('btnDownload');
const btnClear = document.getElementById('btnClear');
const filterInput = document.getElementById('filterInput');
const totalCount = document.getElementById('totalCount');
const uniqueCount = document.getElementById('uniqueCount');
const endpointList = document.getElementById('endpointList');
const recordingIndicator = document.getElementById('recordingIndicator');

let isRecording = false;

// Populate all [data-i18n] elements with the active locale's strings
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.setAttribute('placeholder', msg);
  });

  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.setAttribute('title', msg);
  });

  document.title = chrome.i18n.getMessage('popupTitle') || document.title;
}

// Load state on popup open
function loadState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (!res) return;
    isRecording = res.isRecording;
    updateUI(res.total, res.unique);
    refreshPreview();
  });

  chrome.storage.local.get(['filter'], (data) => {
    if (data.filter) filterInput.value = data.filter;
  });
}

function updateUI(total, unique) {
  totalCount.textContent = total || 0;
  uniqueCount.textContent = unique || 0;

  if (isRecording) {
    btnRecord.textContent = chrome.i18n.getMessage('btnStop');
    btnRecord.classList.add('recording');
    recordingIndicator.classList.add('active');
  } else {
    btnRecord.textContent = chrome.i18n.getMessage('btnStart');
    btnRecord.classList.remove('recording');
    recordingIndicator.classList.remove('active');
  }

  btnDownload.disabled = (total === 0);
}

function renderEndpoints(endpoints) {
  if (!endpoints || endpoints.length === 0) {
    endpointList.innerHTML = `<div class="empty-state">${chrome.i18n.getMessage('emptyState')}</div>`;
    return;
  }

  endpointList.innerHTML = endpoints.slice().reverse().map(e => {
    const urlObj = (() => { try { return new URL(e.url); } catch { return null; } })();
    const path = urlObj ? (urlObj.hostname + urlObj.pathname) : e.url;
    const shortUrl = path.length > 45 ? '...' + path.slice(-42) : path;
    const methodClass = e.method || 'GET';

    return `
      <div class="endpoint">
        <span class="method ${methodClass}">${e.method || 'GET'}</span>
        <span class="endpoint-url" title="${e.url}">${shortUrl}</span>
        <span class="status-dot" style="background: ${e.status >= 200 && e.status < 300 ? '#22c55e' : '#ef4444'}"></span>
      </div>
    `;
  }).join('');
}

function refreshPreview() {
  chrome.runtime.sendMessage({ type: 'GET_PREVIEW' }, (res) => {
    if (res?.endpoints) renderEndpoints(res.endpoints);
  });

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (res) updateUI(res.total, res.unique);
  });
}

// Record / Stop button
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    const filter = filterInput.value.trim();
    // Get the active tab so we only record on it
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id || null;

    chrome.runtime.sendMessage({ type: 'START', filter, tabId }, () => {
      isRecording = true;
      chrome.storage.local.set({ filter });
      updateUI(0, 0);
      // Show which tab it's recording on
      const hostname = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return tab.url; } })() : chrome.i18n.getMessage('currentTabFallback');
      endpointList.innerHTML = `<div class="empty-state">${chrome.i18n.getMessage('recordingOnTab')} <strong style="color:#22c55e">${hostname}</strong><br>${chrome.i18n.getMessage('useTheSiteNormally')}</div>`;
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP' }, () => {
      isRecording = false;
      refreshPreview();
    });
  }
});

// Download button
btnDownload.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = tab?.url ? new URL(tab.url).hostname : 'unknown';

  chrome.runtime.sendMessage({ type: 'DOWNLOAD', site }, (res) => {
    if (!res?.data) return;

    const blob = new Blob([res.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `api-capture-${site}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Clear button
btnClear.addEventListener('click', () => {
  if (!confirm(chrome.i18n.getMessage('confirmClearData'))) return;
  chrome.runtime.sendMessage({ type: 'CLEAR' }, () => {
    updateUI(0, 0);
    endpointList.innerHTML = `<div class="empty-state">${chrome.i18n.getMessage('emptyState')}</div>`;
  });
});

// Auto-refresh while recording
setInterval(() => {
  if (isRecording) refreshPreview();
}, 1500);

// Start
applyI18n();
loadState();
