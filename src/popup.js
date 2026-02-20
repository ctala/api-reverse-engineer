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

// Cargar estado al abrir popup
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
    btnRecord.textContent = '⏹ Detener';
    btnRecord.classList.add('recording');
    recordingIndicator.classList.add('active');
  } else {
    btnRecord.textContent = '▶ Iniciar';
    btnRecord.classList.remove('recording');
    recordingIndicator.classList.remove('active');
  }

  btnDownload.disabled = (total === 0);
}

function renderEndpoints(endpoints) {
  if (!endpoints || endpoints.length === 0) {
    endpointList.innerHTML = '<div class="empty-state">Presiona Iniciar y usa el sitio normalmente</div>';
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

// Botón Record / Stop
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    const filter = filterInput.value.trim();
    // Obtener el tab activo para grabar solo en él
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id || null;

    chrome.runtime.sendMessage({ type: 'START', filter, tabId }, () => {
      isRecording = true;
      chrome.storage.local.set({ filter });
      updateUI(0, 0);
      // Mostrar en qué tab está grabando
      const hostname = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return tab.url; } })() : 'tab actual';
      endpointList.innerHTML = `<div class="empty-state">Grabando en <strong style="color:#22c55e">${hostname}</strong><br>Usa el sitio normalmente</div>`;
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP' }, () => {
      isRecording = false;
      refreshPreview();
    });
  }
});

// Botón Descargar
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

// Botón Limpiar
btnClear.addEventListener('click', () => {
  if (!confirm('¿Limpiar todos los datos capturados?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR' }, () => {
    updateUI(0, 0);
    endpointList.innerHTML = '<div class="empty-state">Presiona Iniciar y usa el sitio normalmente</div>';
  });
});

// Auto-refresh mientras está grabando
setInterval(() => {
  if (isRecording) refreshPreview();
}, 1500);

// Iniciar
loadState();
