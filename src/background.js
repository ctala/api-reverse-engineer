/**
 * API Reverse Engineer — Background Service Worker (v1.3.0)
 * Almacena los requests capturados, actualiza badge, serializa a JSONL.
 *
 * Capture Mode (v1.3.0):
 *   - captureConfig (preset + filter + redact patterns) se persiste en
 *     chrome.storage.session, igual que captured/uniqueKeys, para sobrevivir
 *     el SW wake-up.
 *   - DOWNLOAD_JSONL produce un archivo `.jsonl` (un evento por línea).
 *   - DOWNLOAD (legacy) sigue produciendo el shape v1.2.3 {meta, endpoints, all}.
 *   - Truncación: 5 MB por response body, binaries omitidos, 10k events cap.
 */

const MAX_EVENTS = 10000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const WARNING_AT = 9000;
// Bug fix 2026-06-24: also cap the TOTAL memory footprint of `captured[]`
// to avoid SW OOM (was unbounded before — at MAX_EVENTS with 5MB events
// that's 50GB potential, which would crash the SW long before the user
// downloaded anything). When we hit this cap, drop the oldest events
// (FIFO) and keep capturing — the user just sees a slightly truncated
// session. Trade-off vs quota: session storage is gone, but the
// in-memory buffer is bounded to ~50MB which is SW-safe.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB

let captured = [];
let uniqueKeys = new Set();
let totalBytes = 0; // Bug fix 2026-06-24: tracks in-memory footprint for FIFO eviction
let isRecording = false;
let recordingTabId = null;
let captureConfig = null;
let outputFormat = 'jsonl'; // 'jsonl' | 'json-array'
let filterMode = 'OR';

// Restore state when service worker wakes up.
// Bug fix 2026-06-24: chrome.storage.session has a 10MB quota total. We
// previously persisted the full `captured[]` array on every CAPTURE
// message, which threw 'Session storage quota bytes exceeded' after ~50-100
// large LinkedIn Voyager/GraphQL responses. Fix: persist ONLY metadata
// (counters + isRecording + config). The actual `captured[]` buffer
// stays in memory only — if the SW crashes, the buffer is lost. That's
// acceptable because (a) the SW doesn't crash mid-session in normal use,
// (b) the popup restores counters from `total`/`unique` in GET_STATE, not
// from the array, and (c) the consumer downloads the JSONL on Stop.
//
// Trade-off: if you forget to Stop before closing the browser, you lose
// the captures. Same as before the fix (session storage cleared on browser
// close). Net result: no quota error, no data loss in normal flow.
chrome.storage.session.get(
  ['isRecording', 'recordingTabId', 'captureConfig', 'outputFormat', 'filterMode'],
  (data) => {
    if (data && data.isRecording) {
      isRecording = data.isRecording;
      recordingTabId = data.recordingTabId || null;
      captureConfig = data.captureConfig || null;
      outputFormat = data.outputFormat || 'jsonl';
      filterMode = data.filterMode || 'OR';
      // captured[] and uniqueKeys start empty after SW restart.
      // The user will need to re-record, but the session is still active
      // (isRecording=true), so re-clicking Iniciar isn't needed — but they
      // WILL see '0 REQUESTS' until they navigate again.
    }
  }
);

function _persistSession() {
  try {
    chrome.storage.session.set({
      isRecording,
      recordingTabId,
      captureConfig,
      outputFormat,
      filterMode
    });
  } catch (e) {
    console.error('[ARE] Failed to persist session:', e);
  }
}

// Recibir captures desde content scripts
chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  if (msg.type === 'CAPTURE') {
    // Solo capturar del tab donde se inició el recording
    const tabId = sender.tab && sender.tab.id;
    if (recordingTabId !== null && tabId !== recordingTabId) {
      respond({ ok: true });
      return true;
    }

    const entry = msg.entry;
    if (!entry || !entry.url || !entry.method) {
      respond({ ok: true });
      return true;
    }

    // Apply 5MB body truncation + binary skip BEFORE storing. Doing it here
    // keeps captured[] bounded regardless of what content.js sends.
    const processed = _truncateEntry(entry);

    const key = `${processed.method}:${processed.url.split('?')[0]}`;
    const isNew = !uniqueKeys.has(key);
    uniqueKeys.add(key);

    const entryWithMeta = Object.assign({}, processed, { isNewEndpoint: isNew });
    const entryBytes = _estimateEntryBytes(entryWithMeta);
    captured.push(entryWithMeta);
    totalBytes += entryBytes;

    // Bug fix 2026-06-24: total memory cap (FIFO eviction of oldest events
    // when we exceed MAX_TOTAL_BYTES). Prevents SW OOM on long sessions.
    while (totalBytes > MAX_TOTAL_BYTES && captured.length > 1) {
      const dropped = captured.shift();
      totalBytes -= _estimateEntryBytes(dropped);
    }

    // Hard cap: auto-stop at MAX_EVENTS.
    if (captured.length >= MAX_EVENTS) {
      isRecording = false;
      console.warn(`[ARE] Reached ${MAX_EVENTS} events, auto-stopping`);
    }

    _persistSession();

    // Actualizar badge solo en el tab grabando
    if (tabId) {
      const text = captured.length >= WARNING_AT
        ? `${captured.length}!`
        : String(captured.length);
      try {
        chrome.action.setBadgeText({ text, tabId });
        chrome.action.setBadgeBackgroundColor({
          color: captured.length >= WARNING_AT ? '#f59e0b' : '#22c55e',
          tabId
        });
      } catch (e) {}
    }

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    respond({
      isRecording,
      recordingTabId,
      total: captured.length,
      unique: uniqueKeys.size,
      maxEvents: MAX_EVENTS,
      warningAt: WARNING_AT,
      outputFormat,
      captureConfig
    });
    return true;
  }

  if (msg.type === 'START') {
    isRecording = true;
    recordingTabId = msg.tabId || null;
    filter = msg.filter || '';
    captureConfig = msg.captureConfig || null;
    outputFormat = msg.outputFormat || 'jsonl';
    filterMode = (captureConfig && captureConfig.filterMode) || 'OR';
    // Reset captures — START begins a new session.
    captured = [];
    uniqueKeys = new Set();
    totalBytes = 0; // Bug fix 2026-06-24: reset memory tracker

    _persistSession();

    // Persist last user choice to local storage so the popup restores it.
    chrome.storage.local.set({ filter, captureConfig, outputFormat, filterMode });

    // Set badge immediately to show recording started
    if (recordingTabId) {
      try {
        chrome.action.setBadgeText({ text: '●', tabId: recordingTabId });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: recordingTabId });
      } catch (e) {}
    }

    // Inject interceptor scripts into MAIN world (in order: helpers, then
    // interceptors so window.CaptureConfig is defined when injected.js runs).
    if (recordingTabId) {
      chrome.scripting.executeScript({
        target: { tabId: recordingTabId },
        world: 'MAIN',
        files: ['src/capture-config.js', 'src/injected.js']
      }).then(() => {
        console.log('[ARE] Interceptors injected into MAIN world');

        // Push captureConfig to content.js → injected.js BEFORE the first
        // request fires. We do this via START_RECORDING + SET_CAPTURE_CONFIG.
        chrome.tabs.sendMessage(recordingTabId, {
          type: 'START_RECORDING',
          filter
        }).catch((err) => {
          console.warn('[ARE] Failed to send START_RECORDING to tab', recordingTabId, err);
        });

        if (captureConfig) {
          chrome.tabs.sendMessage(recordingTabId, {
            type: 'SET_CAPTURE_CONFIG',
            captureConfig
          }).catch((err) => {
            console.warn('[ARE] Failed to send SET_CAPTURE_CONFIG to tab', recordingTabId, err);
          });
        }
      }).catch((err) => {
        console.error('[ARE] Failed to inject interceptors:', err);
      });
    }

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'STOP') {
    isRecording = false;
    _persistSession();

    if (recordingTabId) {
      try {
        chrome.tabs.sendMessage(recordingTabId, { type: 'STOP_RECORDING' }).catch(() => {});
        chrome.action.setBadgeText({ text: '', tabId: recordingTabId });
      } catch (e) {}
    }
    recordingTabId = null;

    respond({ ok: true });
    return true;
  }

  // -------------------------------------------------------------------------
  // DOWNLOAD — JSONL (v1.3.0 default) or legacy JSON array (v1.2.3 shape)
  // -------------------------------------------------------------------------
  if (msg.type === 'DOWNLOAD') {
    const format = msg.format || outputFormat || 'jsonl';
    const site = msg.site || 'unknown';
    const preset = (captureConfig && captureConfig.preset) || 'generic';
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

    if (format === 'json-array') {
      // Legacy v1.2.3 shape: {meta, endpoints, all}.
      const unique = {};
      captured.forEach((r) => {
        const key = `${r.method}:${r.url.split('?')[0]}`;
        if (!unique[key] || r.isNewEndpoint) unique[key] = r;
      });
      const data = {
        meta: {
          capturedAt: new Date().toISOString(),
          total: captured.length,
          uniqueEndpoints: Object.keys(unique).length,
          site,
          preset
        },
        endpoints: Object.values(unique),
        all: captured
      };
      respond({
        data: JSON.stringify(data, null, 2),
        filename: `api-capture-${preset}-${isoStamp}.json`,
        format: 'json-array'
      });
      return true;
    }

    // JSONL (v1.3.0 default): one event per line. Use responseBody which is
    // already truncated to MAX_BODY_BYTES by _truncateEntry. Entries already
    // come redacted from injected.js.
    const lines = captured.map((entry) => _toJsonlLine(entry));
    const data = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    const filename = `are-capture-${preset}-${isoStamp}.jsonl`;
    respond({ data, filename, format: 'jsonl', lineCount: lines.length });
    return true;
  }

  if (msg.type === 'CLEAR') {
    captured = [];
    uniqueKeys = new Set();
    totalBytes = 0; // Bug fix 2026-06-24: reset memory tracker too
    _persistSession();

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          try { chrome.action.setBadgeText({ text: '', tabId: tab.id }); } catch (e) {}
        }
      });
    });

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'GET_PREVIEW') {
    const unique = {};
    captured.forEach((r) => {
      const key = `${r.method}:${r.url.split('?')[0]}`;
      if (!unique[key]) unique[key] = r;
    });
    respond({ endpoints: Object.values(unique).slice(-20) });
    return true;
  }

  if (msg.type === 'GET_PRESETS') {
    // Pulled from the same constants injected.js uses. Kept here so the popup
    // can render the dropdown without bundling the helpers into the popup.
    respond({
      presets: [
        { id: 'generic', label: '[Generic]', sortOrder: 99 },
        { id: 'linkedin-voyager', label: '[LinkedIn Voyager]', sortOrder: 1 },
        { id: 'graphql', label: '[GraphQL]', sortOrder: 2 },
        { id: 'json-api', label: '[JSON API]', sortOrder: 3 }
      ],
      defaultPresetId: 'linkedin-voyager'
    });
    return true;
  }
});

// ---------------------------------------------------------------------------
// Truncation + binary skip (applied in background; defence in depth)
// ---------------------------------------------------------------------------

const BINARY_TYPES = /^(image\/|video\/|audio\/|application\/octet-stream|application\/pdf|application\/zip|font\/)/;

function _truncateEntry(entry) {
  if (!entry) return entry;
  const out = Object.assign({}, entry);

  // Truncate requestBody if it is a giant string
  if (typeof out.requestBody === 'string' && out.requestBody.length > MAX_BODY_BYTES) {
    out.requestBody = out.requestBody.slice(0, MAX_BODY_BYTES);
    out.requestBodyTruncated = true;
  }

  // Response body — handle binary skip first, then size cap.
  const contentType = (out.responseHeaders && (out.responseHeaders['content-type'] || out.responseHeaders['Content-Type'])) || '';
  const rawBodyBytes = _byteLength(out.responseBody);
  out.responseBodyBytes = rawBodyBytes;

  if (BINARY_TYPES.test(String(contentType).toLowerCase().trim())) {
    out.responseBody = {
      _skipped: 'binary',
      _contentType: contentType,
      _contentLength: rawBodyBytes
    };
    return out;
  }

  if (typeof out.responseBody === 'string' && out.responseBody.length > MAX_BODY_BYTES) {
    const preview = out.responseBody.slice(0, MAX_BODY_BYTES);
    out.responseBody = {
      _truncated: true,
      _originalBytes: rawBodyBytes,
      _keptBytes: _byteLength(preview),
      _preview: preview
    };
  } else if (out.responseBody && typeof out.responseBody === 'object' && rawBodyBytes > MAX_BODY_BYTES) {
    // For object bodies we don't try to partial-truncate; we record size.
    out.responseBody = {
      _truncated: true,
      _originalBytes: rawBodyBytes,
      _note: 'object body exceeded 5 MB; not preserved in capture'
    };
  }

  return out;
}

function _byteLength(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length; // approximation; UTF-8 byte length can differ but length is good enough for the cap signal
  try {
    return JSON.stringify(value).length;
  } catch (e) {
    return 0;
  }
}

// Bug fix 2026-06-24: estimate the in-memory size of a single captured entry.
// Used to track totalBytes for FIFO eviction. Approximation — counts the
// body sizes (the dominant contributor) and a flat per-entry overhead.
function _estimateEntryBytes(entry) {
  if (!entry) return 0;
  let bytes = 256; // flat overhead for the wrapper object + URL + method + headers keys
  bytes += _byteLength(entry.url);
  bytes += _byteLength(entry.requestBody);
  bytes += _byteLength(entry.responseBody);
  bytes += _byteLength(entry.requestHeaders) + _byteLength(entry.responseHeaders);
  return bytes;
}

// ---------------------------------------------------------------------------
// JSONL serialization — one event per line, LF terminated, UTF-8 no BOM.
// The "shape" of each entry matches the spec's field reference (ts, tab,
// preset, request{method,url,headers,body}, response{status,headers,body,
// bodyBytes}, duration_ms). Fields already redacted in injected.js.
// ---------------------------------------------------------------------------

function _toJsonlLine(entry) {
  const line = {
    ts: entry.timestamp || new Date().toISOString(),
    tab: recordingTabId,
    preset: entry.preset || (captureConfig && captureConfig.preset) || 'generic',
    request: {
      method: entry.method,
      url: entry.url,
      headers: entry.requestHeaders || {},
      body: entry.requestBody === undefined ? null : entry.requestBody
    },
    response: {
      status: entry.status,
      headers: entry.responseHeaders || {},
      body: entry.responseBody === undefined ? null : entry.responseBody,
      bodyBytes: entry.responseBodyBytes || 0
    },
    duration_ms: entry.duration
  };
  if (entry.error) line.error = entry.error;
  return JSON.stringify(line);
}
