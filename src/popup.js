/**
 * API Reverse Engineer — Popup Logic (v1.3.0)
 *
 * Capture Mode: 4 new inputs wired here:
 *   - presetSelect (dropdown) — switches the active preset; updates filter +
 *     redact defaults to the preset's defaults.
 *   - filterInput (textarea) — multi-line filter (literal / regex /glob).
 *   - redactToggle (checkbox) — redact secrets ON/OFF.
 *   - outputFormat radios (jsonl / json-array).
 *
 * The popup never bundles the helper functions; the background.js owns them
 * (via src/capture-config.js) and the popup just sends the chosen
 * captureConfig as a plain object.
 */

const btnRecord = document.getElementById('btnRecord');
const btnPause = document.getElementById('btnPause');
const btnDownload = document.getElementById('btnDownload');
const btnClear = document.getElementById('btnClear');
const filterInput = document.getElementById('filterInput');
const presetSelect = document.getElementById('presetSelect');
const redactToggle = document.getElementById('redactToggle');
const redactHint = document.getElementById('redactHint');
const redactRow = document.getElementById('redactRow');
const totalCount = document.getElementById('totalCount');
const uniqueCount = document.getElementById('uniqueCount');
const endpointList = document.getElementById('endpointList');
const recordingIndicator = document.getElementById('recordingIndicator');

let isRecording = false;
let paused = false;

// Single source of truth: presets + the filter parser live in
// src/capture-config.js (loaded by popup.html before this script). The popup no
// longer duplicates them — that drift is what broke the filter (the preset
// patterns were stored as a string but applied as an array, so applyPreset
// silently cleared the filter → captured everything). Falls back to a minimal
// generic preset if the module didn't load.
const CC = (typeof window !== 'undefined' && window.CaptureConfig) || null;
const PRESETS = (CC && CC.PRESETS) || {
  generic: { id: 'generic', label: '[Generic]', sortOrder: 99, patterns: [], exclude: [], filterMode: 'OR', redact: { enabled: true, headers: [], body: [] } }
};
const DEFAULT_PRESET_ID = (CC && CC.DEFAULT_PRESET_ID) || 'generic';

function buildCaptureConfig(presetId) {
  const preset = PRESETS[presetId] || PRESETS.generic ||
    { patterns: [], exclude: [], filterMode: 'OR', redact: { headers: [], body: [] } };
  // The preset's canonical patterns come straight from capture-config.js (NO
  // round-trip through the textarea — that round-trip was the bug). The
  // textarea adds OPTIONAL extra user filters on top.
  const userPatterns = (CC && CC.parseFilter) ? CC.parseFilter(filterInput.value || '') : [];
  const patterns = (preset.patterns || []).concat(userPatterns);

  const filterModeRadio = document.querySelector('input[name="filterMode"]:checked');
  const filterMode = filterModeRadio ? filterModeRadio.value : (preset.filterMode || 'OR');
  const enabled = !!redactToggle.checked;
  const r = preset.redact || { headers: [], body: [] };

  return {
    preset: presetId,
    patterns: patterns,
    exclude: preset.exclude || [],
    filterMode: filterMode,
    redact: {
      enabled: enabled,
      headers: enabled ? (r.headers || []) : [],
      body: enabled ? (r.body || []) : []
    }
  };
}

function applyPreset(presetId) {
  const preset = PRESETS[presetId];
  if (!preset) return;
  // We do NOT dump the preset's patterns into the textarea (that round-trip is
  // what broke the filter). The textarea is for OPTIONAL extra user filters;
  // the preset's own patterns apply from capture-config.js at build time.
  const radios = document.querySelectorAll('input[name="filterMode"]');
  radios.forEach((r) => { r.checked = (r.value === (preset.filterMode || 'OR')); });
  redactToggle.checked = !!(preset.redact && preset.redact.enabled !== false);
  updateRedactHint();
}

// Populate the preset dropdown from the canonical PRESETS (sorted by sortOrder).
function populatePresetDropdown() {
  if (!presetSelect) return;
  const items = Object.keys(PRESETS)
    .map((id) => PRESETS[id])
    .sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
  presetSelect.innerHTML = items
    .map((p) => `<option value="${p.id}">${p.label || p.id}</option>`)
    .join('');
}

function updateRedactHint() {
  if (redactToggle.checked) {
    redactHint.textContent = 'Se redactan cookies, CSRF, y campos comunes antes de guardar.';
    redactHint.style.color = '';
    redactRow.classList.remove('warning');
  } else {
    redactHint.textContent = 'Captures may include `li_at`, `JSESSIONID`, and other auth tokens. Do not commit these.';
    redactHint.style.color = '#f87171';
    redactRow.classList.add('warning');
  }
}

// Cargar estado al abrir popup
function loadState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError || !res) return; // B6: guard contra SW dormido
    isRecording = res.isRecording;
    paused = res.paused;
    updateUI(res.total, res.unique);
    refreshPreview();
    maybeShowPausedBanner(res);
  });

  // Populate the dropdown from the canonical presets before restoring state.
  populatePresetDropdown();

  // Restore the last used settings from chrome.storage.local.
  chrome.storage.local.get(['filter', 'presetId', 'redactEnabled'], (data) => {
    const presetId = (data && data.presetId && PRESETS[data.presetId]) ? data.presetId : DEFAULT_PRESET_ID;
    if (presetSelect) presetSelect.value = presetId;
    applyPreset(presetId);

    // Restore the user's OPTIONAL extra filters (raw textarea string) — NOT the
    // preset patterns (those apply from capture-config.js, no round-trip).
    if (data && typeof data.filter === 'string') filterInput.value = data.filter;
    if (data && typeof data.redactEnabled === 'boolean') redactToggle.checked = data.redactEnabled;
    updateRedactHint();
  });
}

function updateUI(total, unique) {
  totalCount.textContent = total || 0;
  uniqueCount.textContent = unique || 0;

  // Tres estados (Fase 2): IDLE · RECORDING · PAUSED.
  if (isRecording) {
    btnRecord.textContent = '⏹ Detener';
    btnRecord.classList.add('recording');
    btnPause.style.display = '';
    btnPause.textContent = '⏸ Pausar';
    recordingIndicator.classList.add('active');
  } else if (paused) {
    btnRecord.textContent = '⏹ Detener';
    btnRecord.classList.add('recording');
    btnPause.style.display = '';
    btnPause.textContent = '▶ Continuar';
    recordingIndicator.classList.remove('active');
  } else {
    btnRecord.textContent = '▶ Iniciar';
    btnRecord.classList.remove('recording');
    btnPause.style.display = 'none';
    recordingIndicator.classList.remove('recording');
    recordingIndicator.classList.remove('active');
  }

  // En modo OPFS no se descarga "en caliente"; permitimos descargar si hay
  // datos (total > 0), incluso pausado.
  btnDownload.disabled = (total === 0);
}

function renderEndpoints(endpoints) {
  if (!endpoints || endpoints.length === 0) {
    endpointList.innerHTML = '<div class="empty-state">Presiona Iniciar y usa el sitio normalmente</div>';
    return;
  }

  endpointList.innerHTML = endpoints.slice().reverse().map((e) => {
    const urlObj = (() => { try { return new URL(e.url); } catch (err) { return null; } })();
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

function maybeShowPausedBanner(state) {
  if (state && state.paused) {
    endpointList.innerHTML = '<div class="empty-state">⏸ Sesión pausada · <strong style="color:#f59e0b">' +
      (state.total || 0) + '</strong> eventos<br>Continuar para seguir capturando</div>';
  }
}

function refreshPreview() {
  chrome.runtime.sendMessage({ type: 'GET_PREVIEW' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    // B13: en modo OPFS el preview viene vacío POR DISEÑO ([] + opfsMode). No
    // pisar el mensaje "Grabando…/Pausado" con el empty-state de "Iniciar".
    if (res.opfsMode) return;
    if (res.endpoints) renderEndpoints(res.endpoints);
  });

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    isRecording = res.isRecording;
    paused = res.paused;
    updateUI(res.total, res.unique);
    maybeShowPausedBanner(res);
  });
}

// --- Event wiring ---

presetSelect.addEventListener('change', () => {
  applyPreset(presetSelect.value);
  chrome.storage.local.set({ presetId: presetSelect.value });
});

redactToggle.addEventListener('change', () => {
  updateRedactHint();
  try { chrome.storage.local.set({ redactEnabled: redactToggle.checked }); } catch (e) {}
});

filterInput.addEventListener('input', () => {
  // Live persist so reopening the popup keeps the edited filter.
  chrome.storage.local.set({ filter: filterInput.value });
});

document.querySelectorAll('input[name="filterMode"]').forEach((r) => {
  r.addEventListener('change', () => {
    chrome.storage.local.set({ filterMode: r.value });
  });
});

// Botón Record / Stop
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    const filter = filterInput.value.trim();
    const presetId = presetSelect.value || DEFAULT_PRESET_ID;
    const captureConfig = buildCaptureConfig(presetId);
    const outputFormat = 'jsonl';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = (tab && tab.id) || null;

    chrome.runtime.sendMessage({
      type: 'START',
      filter,
      captureConfig,
      outputFormat,
      tabId
    }, () => {
      isRecording = true;
      // Persist last user choice to local storage.
      chrome.storage.local.set({
        filter,
        captureConfig,
        outputFormat,
        presetId
      });
      updateUI(0, 0);
      const hostname = tab && tab.url
        ? (() => { try { return new URL(tab.url).hostname; } catch (e) { return tab.url; } })()
        : 'tab actual';
      endpointList.innerHTML = `<div class="empty-state">Grabando en <strong style="color:#22c55e">${hostname}</strong><br>Usa el sitio normalmente</div>`;
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP' }, () => {
      if (chrome.runtime.lastError) return;
      isRecording = false;
      paused = false;
      refreshPreview();
    });
  }
});

// Botón Pausar / Continuar (Fase 2). Visible solo cuando hay sesión activa
// o pausada. PAUSE conserva el archivo OPFS; RESUME continúa appendeando.
btnPause.addEventListener('click', () => {
  if (isRecording) {
    chrome.runtime.sendMessage({ type: 'PAUSE' }, () => {
      if (chrome.runtime.lastError) return;
      isRecording = false;
      paused = true;
      const total = parseInt(totalCount.textContent, 10) || 0;
      const unique = parseInt(uniqueCount.textContent, 10) || 0;
      updateUI(total, unique);
      maybeShowPausedBanner({ paused: true, total });
    });
  } else if (paused) {
    chrome.runtime.sendMessage({ type: 'RESUME' }, (res) => {
      if (chrome.runtime.lastError || (res && res.ok === false)) return;
      isRecording = true;
      paused = false;
      refreshPreview();
    });
  }
});

// Botón Descargar
btnDownload.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = (tab && tab.url) ? new URL(tab.url).hostname : 'unknown';
  const format = 'jsonl';

  chrome.runtime.sendMessage({ type: 'DOWNLOAD', site, format }, (res) => {
    if (!res) {
      console.error('[ARE Popup] DOWNLOAD got no response from SW');
      return;
    }
    if (res.ok === false) {
      // Bug fix 2026-06-24: SW returns {ok:false, error: '...'} on empty
      // or failed downloads. Show the user what went wrong.
      console.warn('[ARE Popup] Download refused:', res.error);
      alert('No se puede descargar: ' + (res.error || 'unknown error'));
      return;
    }
    if (!res.data) {
      console.error('[ARE Popup] DOWNLOAD response missing data field', res);
      return;
    }

    // Bug fix 2026-06-24: SW returns binary data base64-encoded since v1.4.0
    // (raw text transport can't survive large buffers in the structured-
    // clone message protocol). Decode here if encoding === 'base64'.
    var bytes;
    if (res.encoding === 'base64') {
      try {
        var bin = atob(res.data);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        bytes = arr;
      } catch (e) {
        console.error('[ARE Popup] base64 decode failed:', e);
        alert('Download data corruption: ' + e.message);
        return;
      }
    } else {
      // Legacy v1.3.x path: SW sent raw string. Wrap as Uint8Array for Blob.
      bytes = new TextEncoder().encode(res.data);
    }

    var blob = new Blob([bytes], { type: 'application/x-ndjson' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = res.filename || ('are-capture-' + site + '-' + Date.now() + '.jsonl');
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

// Botón Descargar cookies (Fase 3) — baja un .json con la auth del sitio
// (incluye httpOnly como li_at / JSESSIONID, que fetch no puede leer) vía
// chrome.cookies, para replay. NO se guarda en la captura: es un canal aparte.
const btnDownloadCookies = document.getElementById('btnDownloadCookies');
const cookiesHint = document.getElementById('cookiesHint');
function setCookiesHint(msg, isError) {
  if (!cookiesHint) return;
  cookiesHint.textContent = msg;
  cookiesHint.style.color = isError ? '#f87171' : '';
}
if (btnDownloadCookies) {
  btnDownloadCookies.addEventListener('click', async () => {
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
    const url = tab && tab.url;
    if (!url || /^chrome(-extension)?:\/\//.test(url)) {
      setCookiesHint('Abrí el sitio del que querés las cookies en la pestaña activa.', true);
      return;
    }
    chrome.runtime.sendMessage({ type: 'GET_COOKIES', url }, (res) => {
      if (chrome.runtime.lastError || !res || res.ok === false) {
        setCookiesHint('Error: ' + ((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'desconocido'), true);
        return;
      }
      let host = 'site';
      try { host = new URL(url).hostname; } catch (e) {}
      const payload = {
        capturedAt: new Date().toISOString(),
        url: url,
        host: host,
        count: res.count || 0,
        // Header listo para curl/Postman: -H "Cookie: <cookieHeader>"
        cookieHeader: res.cookieHeader || '',
        cookies: res.cookies || []
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = 'cookies-' + host + '-' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(dlUrl);
      setCookiesHint('✓ ' + (res.count || 0) + ' cookies descargadas (.json con header Cookie para replay).');
    });
  });
}

// Auto-refresh mientras está grabando
// Bug fix 2026-06-24: also poll the state itself (not just preview when
// isRecording=true), so we recover from initial GET_STATE race / SW wake
// delay. Without this, the popup could show 'Iniciar' even when background
// is actively recording (because isRecording stays false module-level until
// GET_STATE returns — and the previous polling did nothing when it was false).
setInterval(() => {
  if (isRecording || paused) {
    refreshPreview();
  } else {
    // Re-fetch state — if SW is now awake and recording/paused, flips the UI.
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      isRecording = res.isRecording;
      paused = res.paused;
      updateUI(res.total, res.unique);
      maybeShowPausedBanner(res);
    });
  }
}, 1500);

// Iniciar
loadState();
