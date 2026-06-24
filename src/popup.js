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

// Preset defaults — mirrors src/capture-config.js PRESETS (kept here so the
// popup can render the dropdown defaults without bundling the helpers).
const PRESET_DEFAULTS = {
  generic: {
    patterns: '',
    filterMode: 'OR',
    redact: { enabled: true, headers: ['cookie','set-cookie','authorization','x-api-key','x-auth-token','csrf-token','x-csrf-token'] }
  },
  'linkedin-voyager': {
    // Bug fix 2026-06-24: patterns MUST be wrapped in /.../ to be parsed as
    // regex by buildCaptureConfig. Previously stored as raw ^... which was
    // round-tripped through the textarea and parsed as a literal substring,
    // matching nothing.
    patterns: '/^https:\\/\\/www\\.linkedin\\.com\\/(voyager\\/api\\/|li\\/track)/',
    filterMode: 'OR',
    redact: {
      enabled: true,
      headers: ['cookie','set-cookie','csrf-token','x-li-pem-metadata','x-li-pem','x-li-track','x-li-decorators','x-restli-protocol-version','authorization']
    }
  },
  graphql: {
    patterns: '/graphql',
    filterMode: 'OR',
    redact: { enabled: true, headers: ['cookie','set-cookie','authorization','x-api-key','x-auth-token','csrf-token','x-csrf-token'] }
  },
  'json-api': {
    patterns: '',
    filterMode: 'OR',
    redact: { enabled: true, headers: ['cookie','set-cookie','authorization','x-api-key','x-auth-token','csrf-token','x-csrf-token'] }
  }
};

const REDACT_BODY_KEYS = ['password','client_secret','access_token','refresh_token','id_token','session_token','csrf_token','private_key','privateKey','code','cookie','set-cookie'];

function buildCaptureConfig(presetId) {
  const preset = PRESET_DEFAULTS[presetId] || PRESET_DEFAULTS['linkedin-voyager'];
  const rawText = filterInput.value || '';
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Re-encode each line into the {type,value} shape. We use a minimal
  // parser here; the source-of-truth parser lives in capture-config.js.
  const patterns = lines.map((line) => {
    if (line.charAt(0) === '/') {
      const last = line.lastIndexOf('/');
      if (last > 0) return { type: 'regex', value: line };
    }
    if (line.indexOf('*') !== -1 || line.indexOf('?') !== -1) {
      return { type: 'glob', value: line };
    }
    return { type: 'literal', value: line };
  });

  const filterModeRadio = document.querySelector('input[name="filterMode"]:checked');
  const filterMode = filterModeRadio ? filterModeRadio.value : 'OR';

  return {
    preset: presetId,
    patterns: patterns,
    filterMode: filterMode,
    redact: {
      enabled: !!redactToggle.checked,
      headers: preset.redact.enabled && redactToggle.checked ? preset.redact.headers : [],
      body: redactToggle.checked ? REDACT_BODY_KEYS : []
    }
  };
}

function applyPreset(presetId) {
  const defaults = PRESET_DEFAULTS[presetId];
  if (!defaults) return;
  // defaults.patterns is an array of {type, value} objects (see capture-config.js).
  // The textarea takes a string, so we serialize properly: one pattern value per line.
  // Bug fix 2026-06-24: previously used `defaults.patterns || ''` which produced
  // "[object Object],[object Object]" garbage in the textarea and made the
  // LinkedIn Voyager preset capture nothing.
  if (Array.isArray(defaults.patterns) && defaults.patterns.length > 0) {
    filterInput.value = defaults.patterns.map((p) => p.value).join('\n');
  } else {
    filterInput.value = '';
  }
  const radios = document.querySelectorAll('input[name="filterMode"]');
  radios.forEach((r) => { r.checked = (r.value === defaults.filterMode); });
  redactToggle.checked = defaults.redact.enabled !== false;
  updateRedactHint();
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

  // Restore the last used settings from chrome.storage.local.
  chrome.storage.local.get(['filter', 'captureConfig', 'outputFormat', 'presetId'], (data) => {
    const presetId = (data && data.presetId) || (data.captureConfig && data.captureConfig.preset) || 'linkedin-voyager';
    if (presetSelect && PRESET_DEFAULTS[presetId]) {
      presetSelect.value = presetId;
    }
    applyPreset(presetId);

    // If we have saved multi-line filter + redact state, overlay on the
    // preset defaults (which were just applied above).
    if (data && data.captureConfig) {
      const cfg = data.captureConfig;
      if (Array.isArray(cfg.patterns) && cfg.patterns.length > 0) {
        filterInput.value = cfg.patterns.map((p) => p.value).join('\n');
      } else if (typeof data.filter === 'string' && data.filter.length > 0) {
        // Legacy v1.2.3 single-string filter — preserve it.
        filterInput.value = data.filter;
      }
      if (cfg.filterMode) {
        const radios = document.querySelectorAll('input[name="filterMode"]');
        radios.forEach((r) => { r.checked = (r.value === cfg.filterMode); });
      }
      if (cfg.redact && typeof cfg.redact.enabled === 'boolean') {
        redactToggle.checked = cfg.redact.enabled;
      }
    }
    if (data && data.outputFormat) {
      const radios = document.querySelectorAll('input[name="outputFormat"]');
      radios.forEach((r) => { r.checked = (r.value === data.outputFormat); });
    }
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

document.querySelectorAll('input[name="outputFormat"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) chrome.storage.local.set({ outputFormat: r.value });
  });
});

// Botón Record / Stop
btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    const filter = filterInput.value.trim();
    const presetId = presetSelect.value || 'linkedin-voyager';
    const captureConfig = buildCaptureConfig(presetId);
    const outputFormatRadio = document.querySelector('input[name="outputFormat"]:checked');
    const outputFormat = outputFormatRadio ? outputFormatRadio.value : 'jsonl';

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
  const outputFormatRadio = document.querySelector('input[name="outputFormat"]:checked');
  const format = outputFormatRadio ? outputFormatRadio.value : 'jsonl';

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

    var mime = format === 'json-array' ? 'application/json' : 'application/x-ndjson';
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = res.filename || (format === 'json-array'
      ? 'api-capture-' + site + '-' + Date.now() + '.json'
      : 'are-capture-' + site + '-' + Date.now() + '.jsonl');
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
