/**
 * API Reverse Engineer — Background Service Worker (v1.4.2)
 *
 * Capture Mode + OPFS streaming buffer per ADR-0002.
 *
 * v1.4.2 — runtime bug fixes (counter, badge, download) + QA harness.
 *   - bug #1 fix: activeBuffer is now `memoryBuffer` SYNCHRONOUSLY when
 *     START runs, then upgraded to opfsBuffer async once the OPFS file
 *     is open. CAPTUREs that arrive during the OPFS init window go to
 *     memory (counted + retrievable) and are migrated to the OPFS file
 *     once init resolves — no silent loss, no duplicates in the output.
 *   - bug #2 fix (counter): the counter now reflects the active buffer
 *     at all times because memoryBuffer is always safe. v1.4.1 dropped
 *     early CAPTUREs because `if (activeBuffer)` was false during the
 *     OPFS init window.
 *   - bug #2 fix (badge UX): the badge is now driven by the `isRecording`
 *     flag, not by the counter. While recording, the badge shows a red
 *     dot `●` (text+background). The counter goes in the popup only.
 *     v1.4.1 alternated between `●` and the count on every CAPTURE.
 *   - bug #3 fix (download): DOWNLOAD now validates `inMemoryCount > 0`
 *     up front and returns `{ok: false, error: ...}` if there is nothing
 *     to download. The OPFS → memory fallback path returns
 *     `{ok: true, ...}` on success and `{ok: false, error: ...}` if BOTH
 *     paths fail (was: silent empty JSONL).
 *   - bug #4 fix (atomic badge): START / STOP / AUTO_STOP all call
 *     `_setBadge(tabId)` immediately so the badge always reflects the
 *     isRecording state. SW restore (line 100-115) also sets the badge
 *     if isRecording was true.
 *   - defensive: if `activeBuffer` is null when a CAPTURE arrives but
 *     isRecording is true (e.g. after SW restart), fall back to the
 *     memory buffer so captures are not silently dropped.
 *
 * Buffer architecture (v1.4.0 + v1.4.2 race fix):
 *   - Primary path: append streaming writes to `captures.jsonl` in the
 *     extension's OPFS via `OpfsBuffer` (src/opfs-buffer.js). One entry
 *     per line, JSONL format. Survives SW restart, browser close, OOM.
 *   - Fallback path: if OPFS is unavailable (Chrome < 102 or the init
 *     call throws), fall back to the v1.3.2 in-memory array. The plugin
 *     still works, but the OOM risk returns. We surface a warning
 *     (yellow badge) so the user knows the capture is in fallback mode.
 *   - During START, activeBuffer = memoryBuffer synchronously. The async
 *     OPFS upgrade, when it resolves, migrates the memory snapshot to
 *     the OPFS file and switches activeBuffer to opfsBuffer.
 *
 * Counters:
 *   - `inMemoryCount` (number): total events captured this session, kept
 *     in module-level memory. Used for GET_STATE.total and DOWNLOAD validation.
 *   - `inMemoryUnique` (Set<string>): dedup keys (METHOD:URL-without-query).
 *     Used for GET_STATE.unique. Cleared on START and CLEAR.
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

// ---------------------------------------------------------------------------
// B1 fix (2026-06-24): the MV3 service worker is a CLASSIC script — the
// manifest declares `service_worker` WITHOUT `type:module`, and Chrome loads
// ONLY this file. The buffer dependencies are NOT auto-injected, so we must
// pull them in via importScripts BEFORE the IIFE below reads self.OpfsBuffer /
// self.MemoryBuffer. Without this, both are null and the SW captures NOTHING
// in real Chrome (the 71-green-but-broken suite never caught it because the
// mock pre-attached the buffers to globalThis — see test/sw-wiring.test.mjs).
//
//   - Production SW:        importScripts is defined → loads the deps.
//   - Honest unit loader:   test/_sw-loader.mjs provides importScripts.
//   - Legacy CJS harness:   importScripts is undefined (require() context) →
//                           this is a no-op and the harness attaches the
//                           buffers to globalThis itself (loadBackgroundFresh).
// ---------------------------------------------------------------------------
if (typeof importScripts === 'function') {
  importScripts('/src/memory-buffer.js', '/src/opfs-buffer.js');
}

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
  // v1.4.2: also restore the badge (red dot) so the user sees the recording
  // state after a SW restart. If activeBuffer is null, fall back to the
  // memory buffer synchronously so the first CAPTURE after restart goes
  // somewhere safe (was silently dropped in v1.4.1).
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
          // SW restart reset activeBuffer to null. Re-point it to the safe
          // memory buffer so the first CAPTURE after restart doesn't get
          // dropped by the `if (activeBuffer)` guard in the CAPTURE handler.
          if (!activeBuffer && memoryBuffer) {
            activeBuffer = memoryBuffer;
          }
          // Restore the red-dot badge so the user sees the recording state.
          if (recordingTabId) _setBadge(recordingTabId);
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

  /**
   * v1.4.2: badge is now driven purely by `isRecording` (not by the
   * counter). While recording, the badge shows a red dot `●` with the
   * accent background colour. The counter goes in the popup only —
   * v1.4.1 alternated between `●` and the count on every CAPTURE which
   * was a UX bug. When not recording, the badge is cleared.
   *
   * Signature: `_setBadge(tabId)`. The `count` parameter from v1.4.1
   * has been removed (it was the source of the alternating bug).
   */
  function _setBadge(tabId) {
    if (typeof chrome === 'undefined' || !chrome.action) return;
    if (!tabId) return;
    if (isRecording) {
      // While recording, show red dot. Counter goes in popup only.
      try {
        chrome.action.setBadgeText({ text: '●', tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tabId });
      } catch (e) {}
      return;
    }
    // When stopped, clear badge.
    try { chrome.action.setBadgeText({ text: '', tabId: tabId }); } catch (e) {}
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

        // v1.4.2 defensive: if activeBuffer is null (e.g. after SW restart
        // before the restore callback finished) but we're still in a
        // recording state, fall back to the memory buffer so the CAPTURE
        // isn't silently dropped. Pre-empts the v1.4.1 silent-loss bug.
        if (!activeBuffer && isRecording && memoryBuffer) {
          activeBuffer = memoryBuffer;
        }

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
          // v1.4.2: atomic badge clear on auto-stop.
          _setBadge(recordingTabId);
        }

        _persistSession();
        // v1.4.2: badge is driven by isRecording flag (no count). No call
        // to _setBadge here — START/STOP/AUTO_STOP own the badge.

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
      // v1.4.2: activeBuffer is memoryBuffer SYNCHRONOUSLY (was: null until
      // the async OPFS init resolved, dropping every CAPTURE in the init
      // window). The OPFS upgrade still happens async; on success we
      // migrate the memory snapshot to the OPFS file and switch the active
      // buffer. No duplicates in the output, no silent loss.
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

        // SYNCHRONOUS fallback: memoryBuffer is always safe. OPFS upgrade
        // happens async below — captures during the init window go to the
        // memory buffer (counted + retrievable).
        activeBuffer = memoryBuffer;
        opfsAvailable = false;

        // ASYNC OPFS upgrade (best-effort).
        if (opfsBuffer) {
          opfsBuffer.init().then(function (ok) {
            if (ok && isRecording) {
              // Migrate any captures we accumulated during the init
              // window from memoryBuffer to OPFS. We append, NOT copy +
              // truncate, so the order is preserved and the output is a
              // single contiguous JSONL stream.
              var existing = memoryBuffer.snapshot();
              activeBuffer = opfsBuffer;
              for (var i = 0; i < existing.length; i++) {
                opfsBuffer.append(existing[i]);
              }
              opfsAvailable = true;
              inMemoryCount = opfsBuffer.getCount();
              _setBadge(recordingTabId);
              console.log('[ARE] OPFS ready, migrated ' + existing.length + ' captures from memory buffer');
            } else if (!ok && isRecording) {
              // OPFS init failed — keep the memory buffer as the active
              // buffer. The download path will fall back to memory JSONL.
              activeBuffer = memoryBuffer;
              opfsAvailable = false;
              console.warn('[ARE] OPFS unavailable, using in-memory fallback');
            }
          }).catch(function (e) {
            console.error('[ARE] OPFS init failed, staying on memory buffer:', e);
            if (isRecording) activeBuffer = memoryBuffer;
          });
        }

        _persistSession();

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ filter: filter, captureConfig: captureConfig, outputFormat: outputFormat, filterMode: filterMode });
        }

        // v1.4.2: atomic badge update on START (red dot, not counter).
        _setBadge(recordingTabId);

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
          } catch (e) {}
        }
        // v1.4.2: atomic badge clear on STOP. We do this BEFORE clearing
        // recordingTabId so the badge lands on the right tab.
        if (recordingTabId) _setBadge(recordingTabId);
        recordingTabId = null;

        respond({ ok: true });
        return true;
      }

      // -----------------------------------------------------------------------
      // DOWNLOAD
      // v1.4.2: validate `inMemoryCount > 0` up front and return
      // `{ok: false, error: ...}` if there's nothing to download. The
      // OPFS → memory fallback path returns `{ok: false, error: ...}`
      // if BOTH paths fail (was: silent empty JSONL in v1.4.1). The
      // popup surfaces the error to the user.
      // -----------------------------------------------------------------------
      if (msg.type === 'DOWNLOAD') {
        var format = msg.format || outputFormat || 'jsonl';
        var site = msg.site || 'unknown';
        var preset = (captureConfig && captureConfig.preset) || 'generic';
        var isoStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

        // v1.4.2: short-circuit on empty capture. The user needs to know
        // why nothing downloaded (silent failure was the v1.4.1 bug).
        if (inMemoryCount <= 0) {
          respond({
            ok: false,
            error: 'No captures to download. Did you navigate a page after clicking Iniciar?',
            format: format,
            lineCount: 0
          });
          return true;
        }

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
            ok: true,
            data: JSON.stringify(data, null, 2),
            filename: 'api-capture-' + preset + '-' + isoStamp + '.json',
            format: 'json-array'
          });
          return true;
        }

        // JSONL (v1.3.0 default) — try OPFS first if active, else serialise
        // the in-memory array. Always fall back to memory on any OPFS
        // failure. If both paths fail, return ok:false so the popup can
        // show the user what went wrong.
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
              ok: true,
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
            var memFallback = _buildJsonlFromMemory(preset, isoStamp);
            if (memFallback.lineCount > 0) {
              respond(memFallback);
            } else {
              respond({
                ok: false,
                error: 'Download failed: OPFS read error and in-memory buffer is empty. ' + (e && e.message || String(e)),
                format: 'jsonl',
                lineCount: 0
              });
            }
          });
          return true; // async response
        }

        // Fallback: serialise memoryBuffer snapshot as before.
        var memResult = _buildJsonlFromMemory(preset, isoStamp);
        respond(memResult);
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
    var raw = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    // v1.4.2: encode as base64 uniformly so the popup can decode both
    // the OPFS and memory paths with the same code. The v1.4.1 dual
    // format (OPFS = base64, memory = string) caused the popup to
    // produce a base64-text file when OPFS was active.
    var b64;
    try {
      b64 = (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(raw))) : Buffer.from(raw, 'utf-8').toString('base64');
    } catch (e) {
      b64 = Buffer.from(raw, 'utf-8').toString('base64');
    }
    return {
      ok: true,
      data: b64,
      encoding: 'base64',
      mime: 'application/x-ndjson',
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
