/**
 * API Reverse Engineer — Background Service Worker (v1.4.0)
 *
 * Capture Mode + OPFS streaming buffer per ADR-0002.
 *
 * Buffer architecture (v1.4.0):
 *   - Primary path: append streaming writes to `captures.jsonl` in the
 *     extension's OPFS via `OpfsBuffer` (src/opfs-buffer.js). One entry
 *     per line, JSONL format. Survives SW restart, browser close, OOM.
 *   - Fallback path: if OPFS is unavailable (Chrome < 102 or the init
 *     call throws), fall back to the v1.3.2 in-memory array. The plugin
 *     still works, but the OOM risk returns. We surface a warning
 *     (yellow badge) so the user knows the capture is in fallback mode.
 *
 * Counters:
 *   - `inMemoryCount` (number): total events captured this session, kept
 *     in module-level memory. Used for the badge and GET_STATE.total.
 *   - `inMemoryUnique` (Set<string>): dedup keys (METHOD:URL-without-query).
 *     Used for GET_STATE.unique. Cleared on START and CLEAR.
 *   - `captured[]` (Array): ONLY used in the v1.3.2 fallback path. If
 *     OPFS init succeeds this array stays empty; if OPFS init fails, all
 *     writes go here and DOWNLOAD reads from it.
 *
 * Privacy:
 *   - Redaction happens at the injection site (injected.js MAIN world) so
 *     raw cookies / csrf tokens never cross postMessage into the SW.
 *   - `chrome.storage.session` persists only metadata (counters +
 *     isRecording + captureConfig). The capture buffer itself is never
 *     serialised to chrome.storage (v1.3.2 fix retained).
 *
 * Node compatibility:
 *   - The chrome.* API calls at the top level are guarded by
 *     `typeof chrome !== 'undefined'` so the file can be loaded by
 *     `node -e "import('./src/background.js')"` for syntax validation
 *     and lightweight smoke tests. The chrome-specific code paths are
 *     only exercised in the SW context.
 */

(function (root, factory) {
  'use strict';
  var api = factory();
  // Service-worker context: nothing global to expose (the SW doesn't run
  // a "module" — the IIFE is just the top-level script body). The OpfsBuffer
  // helper used here is loaded as a separate classic script via
  // web_accessible_resources / service-worker-script, OR — for now — we
  // also expose a window/global symbol for tests and node compatibility.
  if (typeof self !== 'undefined') {
    self.__ARE_BACKGROUND__ = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.__ARE_BACKGROUND__ = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var OpfsBuffer = (typeof window !== 'undefined' && window.OpfsBuffer)
    || (typeof self !== 'undefined' && self.OpfsBuffer)
    || (typeof globalThis !== 'undefined' && globalThis.OpfsBuffer)
    || null;

  var MemoryBuffer = (typeof window !== 'undefined' && window.MemoryBuffer)
    || (typeof self !== 'undefined' && self.MemoryBuffer)
    || (typeof globalThis !== 'undefined' && globalThis.MemoryBuffer)
    || null;

  var MAX_EVENTS = 10000;
  var MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
  var WARNING_AT = 9000;

  // ----- Module-level state (v1.4.0) -----
  var inMemoryCount = 0;       // total events this session
  var inMemoryUnique = new Set(); // METHOD:URL dedup keys
  var isRecording = false;
  var recordingTabId = null;
  var captureConfig = null;
  var outputFormat = 'jsonl';
  var filterMode = 'OR';

  // OPFS streaming buffer (primary path).
  var opfsBuffer = OpfsBuffer ? OpfsBuffer.createOpfsBuffer({ filename: 'captures.jsonl' }) : null;
  var opfsAvailable = !!opfsBuffer; // set to false on init failure
  // In-memory fallback buffer (used when OPFS is unavailable).
  var memoryBuffer = MemoryBuffer ? MemoryBuffer.createMemoryBuffer() : null;
  // The active buffer — whichever is in use right now. Updated when OPFS
  // init succeeds / fails / mid-session write fails.
  var activeBuffer = null;

  // ---------------------------------------------------------------------------
  // chrome.storage.session — restore isRecording / config on SW wake-up
  // (Captures themselves live in OPFS now, so we don't persist the array.)
  // ---------------------------------------------------------------------------
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    chrome.storage.session.get(
      ['isRecording', 'recordingTabId', 'captureConfig', 'outputFormat', 'filterMode'],
      function (data) {
        if (data && data.isRecording) {
          isRecording = data.isRecording;
          recordingTabId = data.recordingTabId || null;
          captureConfig = data.captureConfig || null;
          outputFormat = data.outputFormat || 'jsonl';
          filterMode = data.filterMode || 'OR';
          // captured[] and counters start empty after SW restart.
          // The OPFS file persists on disk, so on the next START we truncate
          // it (fresh session per ADR-0002 decision). If the user wants to
          // resume an old session, that is a F4 feature.
        }
      }
    );
  }

  function _persistSession() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
    try {
      chrome.storage.session.set({
        isRecording: isRecording,
        recordingTabId: recordingTabId,
        captureConfig: captureConfig,
        outputFormat: outputFormat,
        filterMode: filterMode
      });
    } catch (e) {
      console.error('[ARE] Failed to persist session:', e);
    }
  }

  // Bug fix 2026-06-24: poll the content script (ISOLATED world) until it
  // responds to PING, with a hard timeout. Fixes the race where the SW
  // sends START_RECORDING immediately after executeScript resolves but
  // the content script's message listener isn't registered yet — the
  // message lands in a no-receiver state and capture never starts.
  // Returns a promise that resolves to true if the content script
  // responded, false on timeout.
  function _waitForContentScript(tabId, timeoutMs) {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
        resolve(false);
        return;
      }
      var deadline = Date.now() + timeoutMs;
      var attempt = function () {
        if (Date.now() > deadline) { resolve(false); return; }
        try {
          chrome.tabs.sendMessage(tabId, { type: 'PING' }, function (resp) {
            if (chrome.runtime.lastError) {
              // No receiver yet — retry after a short delay
              setTimeout(attempt, 100);
            } else if (resp && resp.ready === true) {
              resolve(true);
            } else {
              // Some other response; treat as ready (the listener is alive)
              resolve(true);
            }
          });
        } catch (e) {
          setTimeout(attempt, 100);
        }
      };
      attempt();
    });
  }

  function _setBadge(count, tabId) {
    if (typeof chrome === 'undefined' || !chrome.action) return;
    if (!tabId) return;
    var text = count >= WARNING_AT ? (count + '!') : String(count);
    var color = '#22c55e'; // default green
    if (count >= WARNING_AT) color = '#f59e0b'; // amber
    if (activeBuffer && activeBuffer.inFallbackMode && activeBuffer.inFallbackMode()) color = '#eab308'; // yellow = fallback mode
    try {
      chrome.action.setBadgeText({ text: text, tabId: tabId });
      chrome.action.setBadgeBackgroundColor({ color: color, tabId: tabId });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // chrome.runtime.onMessage — main entry point
  // ---------------------------------------------------------------------------
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {

      // -----------------------------------------------------------------------
      // CAPTURE
      // -----------------------------------------------------------------------
      if (msg.type === 'CAPTURE') {
        var tabId = sender.tab && sender.tab.id;
        if (recordingTabId !== null && tabId !== recordingTabId) {
          respond({ ok: true });
          return true;
        }

        var entry = msg.entry;
        if (!entry || !entry.url || !entry.method) {
          respond({ ok: true });
          return true;
        }

        // Truncate body + binary skip BEFORE storing (defence in depth).
        var processed = _truncateEntry(entry);

        var key = processed.method + ':' + processed.url.split('?')[0];
        var isNew = !inMemoryUnique.has(key);
        inMemoryUnique.add(key);

        var entryWithMeta = Object.assign({}, processed, { isNewEndpoint: isNew });

        if (activeBuffer) {
          var wrote = activeBuffer.append(entryWithMeta);
          if (wrote) {
            inMemoryCount = activeBuffer.getCount();
          } else {
            // The current buffer rejected the write. If we were on OPFS,
            // switch to the memory buffer for the rest of the session.
            if (activeBuffer === opfsBuffer && memoryBuffer) {
              console.warn('[ARE] OPFS write failed, switching to in-memory fallback for this session');
              activeBuffer = memoryBuffer;
              memoryBuffer.append(entryWithMeta);
              inMemoryCount = memoryBuffer.getCount();
              opfsAvailable = false;
            }
          }
        }

        if (inMemoryCount >= MAX_EVENTS) {
          isRecording = false;
          console.warn('[ARE] Reached ' + MAX_EVENTS + ' events, auto-stopping');
        }

        _persistSession();
        _setBadge(inMemoryCount, tabId);

        respond({ ok: true });
        return true;
      }

      // -----------------------------------------------------------------------
      // GET_STATE
      // -----------------------------------------------------------------------
      if (msg.type === 'GET_STATE') {
        var unique = inMemoryUnique.size;
        var isOpfsActive = activeBuffer === opfsBuffer && opfsBuffer && !opfsBuffer.inFallbackMode();
        var isFallback = activeBuffer === memoryBuffer || !activeBuffer || (opfsBuffer && opfsBuffer.inFallbackMode());
        respond({
          isRecording: isRecording,
          recordingTabId: recordingTabId,
          total: inMemoryCount,
          unique: unique,
          maxEvents: MAX_EVENTS,
          warningAt: WARNING_AT,
          outputFormat: outputFormat,
          captureConfig: captureConfig,
          opfsActive: isOpfsActive,
          fallbackMode: isFallback
        });
        return true;
      }

      // -----------------------------------------------------------------------
      // START
      // -----------------------------------------------------------------------
      if (msg.type === 'START') {
        isRecording = true;
        recordingTabId = msg.tabId || null;
        var filter = msg.filter || '';
        captureConfig = msg.captureConfig || null;
        outputFormat = msg.outputFormat || 'jsonl';
        filterMode = (captureConfig && captureConfig.filterMode) || 'OR';

        // Reset in-memory state.
        inMemoryCount = 0;
        inMemoryUnique = new Set();
        if (memoryBuffer) memoryBuffer.clear();

        // Open the OPFS file (truncates any previous session).
        if (opfsBuffer) {
          // Don't await — keep handler non-blocking. If init fails the
          // first CAPTURE switches to the memory buffer.
          opfsBuffer.init().then(function (ok) {
            opfsAvailable = ok;
            if (ok) {
              activeBuffer = opfsBuffer;
              console.log('[ARE] OPFS streaming buffer ready (captures.jsonl)');
            } else {
              activeBuffer = memoryBuffer;
              console.warn('[ARE] OPFS unavailable, using in-memory fallback (v1.3.2 mode)');
            }
          }).catch(function (e) {
            console.error('[ARE] OPFS init threw, using in-memory fallback:', e);
            opfsAvailable = false;
            activeBuffer = memoryBuffer;
          });
        } else {
          opfsAvailable = false;
          activeBuffer = memoryBuffer;
        }

        _persistSession();

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ filter: filter, captureConfig: captureConfig, outputFormat: outputFormat, filterMode: filterMode });
        }

        if (recordingTabId && typeof chrome !== 'undefined' && chrome.action) {
          try {
            chrome.action.setBadgeText({ text: '●', tabId: recordingTabId });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: recordingTabId });
          } catch (e) {}
        }

        if (recordingTabId && typeof chrome !== 'undefined' && chrome.scripting) {
          chrome.scripting.executeScript({
            target: { tabId: recordingTabId },
            world: 'MAIN',
            files: ['src/capture-config.js', 'src/injected.js']
          }).then(function () {
            console.log('[ARE] Interceptors injected into MAIN world');
            // Bug fix 2026-06-24: content script listener may not be ready
            // when we send START_RECORDING immediately after executeScript
            // resolves. Poll for PING response up to 2s, then send.
            _waitForContentScript(recordingTabId, 2000).then(function (ready) {
              if (!ready) {
                console.warn('[ARE] Content script did not respond to PING within 2s. Capture may not start. Reload the tab and try again.');
                return;
              }
              chrome.tabs.sendMessage(recordingTabId, {
                type: 'START_RECORDING',
                filter: filter
              }).catch(function (err) {
                console.warn('[ARE] Failed to send START_RECORDING to tab', recordingTabId, err);
              });
              if (captureConfig) {
                chrome.tabs.sendMessage(recordingTabId, {
                  type: 'SET_CAPTURE_CONFIG',
                  captureConfig: captureConfig
                }).catch(function (err) {
                  console.warn('[ARE] Failed to send SET_CAPTURE_CONFIG to tab', recordingTabId, err);
                });
              }
            });
          }).catch(function (err) {
            console.error('[ARE] Failed to inject interceptors:', err);
          });
        }

        respond({ ok: true });
        return true;
      }

      // -----------------------------------------------------------------------
      // STOP
      // -----------------------------------------------------------------------
      if (msg.type === 'STOP') {
        isRecording = false;
        _persistSession();

        // Close the OPFS access handle (keep the file handle for download).
        if (opfsBuffer) {
          opfsBuffer.close();
        }

        if (recordingTabId && typeof chrome !== 'undefined' && chrome.tabs) {
          try {
            chrome.tabs.sendMessage(recordingTabId, { type: 'STOP_RECORDING' }).catch(function () {});
            if (chrome.action) chrome.action.setBadgeText({ text: '', tabId: recordingTabId });
          } catch (e) {}
        }
        recordingTabId = null;

        respond({ ok: true });
        return true;
      }

      // -----------------------------------------------------------------------
      // DOWNLOAD
      // -----------------------------------------------------------------------
      if (msg.type === 'DOWNLOAD') {
        var format = msg.format || outputFormat || 'jsonl';
        var site = msg.site || 'unknown';
        var preset = (captureConfig && captureConfig.preset) || 'generic';
        var isoStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

        if (format === 'json-array') {
          // Legacy v1.2.3 shape — uses the in-memory array snapshot.
          // In OPFS mode the array is empty (we can't enumerate JSONL
          // lines back into objects cheaply), so the legacy output is
          // a best-effort: meta + uniqueEndpoints=0 + all=[].
          var snapshot = (memoryBuffer && memoryBuffer.snapshot) ? memoryBuffer.snapshot() : [];
          var unique2 = {};
          snapshot.forEach(function (r) {
            var k = r.method + ':' + r.url.split('?')[0];
            if (!unique2[k] || r.isNewEndpoint) unique2[k] = r;
          });
          var data = {
            meta: {
              capturedAt: new Date().toISOString(),
              total: inMemoryCount,
              uniqueEndpoints: Object.keys(unique2).length,
              site: site,
              preset: preset
            },
            endpoints: Object.values(unique2),
            all: snapshot
          };
          respond({
            data: JSON.stringify(data, null, 2),
            filename: 'api-capture-' + preset + '-' + isoStamp + '.json',
            format: 'json-array'
          });
          return true;
        }

        // JSONL (v1.3.0 default) — read from the OPFS file if active, else
        // serialise the in-memory array.
        if (activeBuffer === opfsBuffer && opfsBuffer && !opfsBuffer.inFallbackMode() && typeof opfsBuffer.getFile === 'function') {
          opfsBuffer.getFile().then(function (file) {
            return file.arrayBuffer();
          }).then(function (buf) {
            // Convert to base64 so the message payload survives the
            // structured-clone transport (ArrayBuffer is OK, but base64
            // is portable and tested). Then in the popup we decode + Blob.
            var bytes = new Uint8Array(buf);
            var bin = '';
            for (var i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
            var b64 = (typeof btoa === 'function') ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
            respond({
              data: b64,
              encoding: 'base64',
              mime: 'application/x-ndjson',
              filename: 'are-capture-' + preset + '-' + isoStamp + '.jsonl',
              format: 'jsonl',
              lineCount: inMemoryCount,
              bytes: bytes.byteLength
            });
          }).catch(function (e) {
            console.error('[ARE] OPFS read failed, falling back to in-memory JSONL:', e);
            respond(_buildJsonlFromMemory(preset, isoStamp));
          });
          return true; // async response
        }

        // Fallback: serialise memoryBuffer snapshot as before.
        respond(_buildJsonlFromMemory(preset, isoStamp));
        return true;
      }

      // -----------------------------------------------------------------------
      // CLEAR
      // -----------------------------------------------------------------------
      if (msg.type === 'CLEAR') {
        if (opfsBuffer) {
          opfsBuffer.clear().catch(function (e) {
            console.error('[ARE] OPFS clear failed:', e);
          });
        }
        if (memoryBuffer) memoryBuffer.clear();
        inMemoryUnique = new Set();
        inMemoryCount = 0;
        activeBuffer = null;
        _persistSession();

        if (typeof chrome !== 'undefined' && chrome.tabs) {
          chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (tab) {
              if (tab.id && chrome.action) {
                try { chrome.action.setBadgeText({ text: '', tabId: tab.id }); } catch (e) {}
              }
            });
          });
        }

        respond({ ok: true });
        return true;
      }

      // -----------------------------------------------------------------------
      // GET_PREVIEW
      // -----------------------------------------------------------------------
      if (msg.type === 'GET_PREVIEW') {
        // In OPFS mode, we don't have the raw array in memory. The popup's
        // preview feature is best-effort: in OPFS mode we return an empty
        // list (the popup will display "Grabando…" while recording, and
        // the user can still download the full file). In fallback mode we
        // can return the same preview as v1.3.2.
        if (activeBuffer === opfsBuffer && opfsBuffer && !opfsBuffer.inFallbackMode()) {
          respond({ endpoints: [], opfsMode: true });
          return true;
        }
        var snapshot2 = (memoryBuffer && memoryBuffer.snapshot) ? memoryBuffer.snapshot() : [];
        var unique3 = {};
        snapshot2.forEach(function (r) {
          var k = r.method + ':' + r.url.split('?')[0];
          if (!unique3[k]) unique3[k] = r;
        });
        respond({ endpoints: Object.values(unique3).slice(-20) });
        return true;
      }

      // -----------------------------------------------------------------------
      // GET_PRESETS
      // -----------------------------------------------------------------------
      if (msg.type === 'GET_PRESETS') {
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
  }

  function _buildJsonlFromMemory(preset, isoStamp) {
    var snapshot = (memoryBuffer && memoryBuffer.snapshot) ? memoryBuffer.snapshot() : [];
    var lines = snapshot.map(function (e) { return _toJsonlLine(e); });
    var data = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    return {
      data: data,
      filename: 'are-capture-' + preset + '-' + isoStamp + '.jsonl',
      format: 'jsonl',
      lineCount: lines.length
    };
  }

  // ---------------------------------------------------------------------------
  // Truncation + binary skip (applied in background; defence in depth)
  // ---------------------------------------------------------------------------
  var BINARY_TYPES = /^(image\/|video\/|audio\/|application\/octet-stream|application\/pdf|application\/zip|font\/)/;

  function _truncateEntry(entry) {
    if (!entry) return entry;
    var out = Object.assign({}, entry);
    if (typeof out.requestBody === 'string' && out.requestBody.length > MAX_BODY_BYTES) {
      out.requestBody = out.requestBody.slice(0, MAX_BODY_BYTES);
      out.requestBodyTruncated = true;
    }
    var contentType = (out.responseHeaders && (out.responseHeaders['content-type'] || out.responseHeaders['Content-Type'])) || '';
    var rawBodyBytes = _byteLength(out.responseBody);
    out.responseBodyBytes = rawBodyBytes;
    if (BINARY_TYPES.test(String(contentType).toLowerCase().trim())) {
      out.responseBody = { _skipped: 'binary', _contentType: contentType, _contentLength: rawBodyBytes };
      return out;
    }
    if (typeof out.responseBody === 'string' && out.responseBody.length > MAX_BODY_BYTES) {
      var preview = out.responseBody.slice(0, MAX_BODY_BYTES);
      out.responseBody = { _truncated: true, _originalBytes: rawBodyBytes, _keptBytes: _byteLength(preview), _preview: preview };
    } else if (out.responseBody && typeof out.responseBody === 'object' && rawBodyBytes > MAX_BODY_BYTES) {
      out.responseBody = { _truncated: true, _originalBytes: rawBodyBytes, _note: 'object body exceeded 5 MB; not preserved in capture' };
    }
    return out;
  }

  function _byteLength(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') return value.length;
    try { return JSON.stringify(value).length; } catch (e) { return 0; }
  }

  function _estimateEntryBytes(entry) {
    if (!entry) return 0;
    var bytes = 256;
    bytes += _byteLength(entry.url);
    bytes += _byteLength(entry.requestBody);
    bytes += _byteLength(entry.responseBody);
    bytes += _byteLength(entry.requestHeaders) + _byteLength(entry.responseHeaders);
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // JSONL serialization — one event per line, LF terminated, UTF-8 no BOM.
  // Same shape as v1.3.2 (compatible with the linkedin-all-in-one-api importer).
  // ---------------------------------------------------------------------------
  function _toJsonlLine(entry) {
    var line = {
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

  // Expose internals for tests / introspection. The SW context doesn't
  // touch these; they exist for node-side unit tests + the
  // `node -e "import('./src/background.js')"` smoke validation.
  return {
    MAX_EVENTS: MAX_EVENTS,
    WARNING_AT: WARNING_AT,
    _truncateEntry: _truncateEntry,
    _byteLength: _byteLength,
    _estimateEntryBytes: _estimateEntryBytes,
    _toJsonlLine: _toJsonlLine,
    _buildJsonlFromMemory: _buildJsonlFromMemory,
    getState: function () {
      return {
        inMemoryCount: inMemoryCount,
        uniqueSize: inMemoryUnique.size,
        isRecording: isRecording,
        opfsAvailable: opfsAvailable,
        activeBufferIsOpfs: activeBuffer === opfsBuffer,
        fallbackMode: !activeBuffer || activeBuffer === memoryBuffer || (opfsBuffer && opfsBuffer.inFallbackMode())
      };
    }
  };
}));
