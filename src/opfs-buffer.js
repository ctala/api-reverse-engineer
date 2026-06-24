/**
 * API Reverse Engineer — OPFS Streaming Buffer (v1.4.0)
 *
 * Encapsulates the OPFS streaming capture buffer per ADR-0002:
 *   - Replaces the in-memory `captured[]` array with append-only writes to
 *     `captures.jsonl` in the extension's Origin Private File System.
 *   - Provides a synchronous write API (createSyncAccessHandle) that works
 *     in MV3 service workers (Chrome 102+).
 *   - Survives SW restarts and browser close: the file persists in the OPFS
 *     sandbox; `isRecording` / counters are restored from
 *     chrome.storage.session.
 *   - Graceful fallback: if OPFS is unavailable (Chrome < 102, or the call
 *     throws), the caller is signalled via `inFallbackMode()` so it can
 *     fall back to the v1.3.2 in-memory array path.
 *
 * Loaded two ways (mirrors `src/capture-config.js`):
 *   - Browser / Chrome extension (classic script): attaches `window.OpfsBuffer`.
 *   - Node tests (CJS via createRequire): returns `module.exports`.
 *
 * API surface:
 *   - createOpfsBuffer({ filename?, navigator? })
 *       Returns a buffer instance with:
 *         .init()              — open or create the file, returns Promise<boolean>
 *         .append(entry)       — write one JSONL line, returns boolean (true on success)
 *         .getFile()           — Promise<File> (File API object) for download
 *         .getCount()          — number of lines written this session
 *         .getBytesWritten()   — total bytes flushed
 *         .clear()             — close + delete the file, reset counter
 *         .close()             — close the access handle (file handle kept)
 *         .inFallbackMode()    — true if OPFS init failed
 *         .isOpen()            — true if access handle is currently open
 *         .restoreFromExisting() — re-open a previously persisted file (post-SW-restart)
 *   - inFallbackMode(buffer)    — convenience: !buffer || buffer.inFallbackMode()
 *
 * v1.4.0 trade-off: we DELIBERATELY truncate the file in `init()` (fresh
 * start on every START). A user that wants append-mode needs a separate F4
 * feature. Rationale: SW restart + automatic re-append would silently mix
 * pre-restart and post-restart events, which is hard to debug. Fresh start
 * is predictable; the user clicks START, gets a clean file.
 *
 * Privacy: entries are written as JSONL. Redaction happens at the injection
 * site (injected.js, MAIN world) before postMessage, so this module never
 * touches raw cookies / csrf tokens.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof window !== 'undefined') {
    window.OpfsBuffer = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_FILENAME = 'captures.jsonl';

  /**
   * Create a new OPFS buffer instance.
   *
   * @param {Object} opts
   * @param {string} [opts.filename='captures.jsonl']
   * @param {Object} [opts.navigator] — injectable for tests; defaults to globalThis.navigator
   * @returns {Object} buffer instance
   */
  function createOpfsBuffer(opts) {
    opts = opts || {};
    var filename = opts.filename || DEFAULT_FILENAME;
    // Allow injecting a mock navigator in tests.
    var nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : null);

    var opfsRoot = null;
    var opfsFile = null;
    var opfsAccess = null;
    var opfsBytesWritten = 0;
    var inMemoryCount = 0;
    var fallbackMode = false;
    var initError = null;

    function isOpen() {
      return !!opfsAccess;
    }

    function inFallback() {
      return fallbackMode;
    }

    function getCount() {
      return inMemoryCount;
    }

    function getBytesWritten() {
      return opfsBytesWritten;
    }

    function getError() {
      return initError;
    }

    /**
     * Open (or create) the capture file, truncating any existing one.
     * @returns {Promise<boolean>} true on success, false on fallback
     */
    async function init() {
      // Reset all per-session state.
      opfsBytesWritten = 0;
      inMemoryCount = 0;
      fallbackMode = false;
      initError = null;
      opfsRoot = null;
      opfsFile = null;
      opfsAccess = null;

      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
        // OPFS not available (older Chrome, or test env without mock).
        fallbackMode = true;
        initError = new Error('navigator.storage.getDirectory is not available');
        return false;
      }

      try {
        opfsRoot = await nav.storage.getDirectory();
        // Fresh start: delete any existing file before creating a new one.
        // (Documented in ADR-0002 — append mode is a future F4 feature.)
        try {
          await opfsRoot.removeEntry(filename);
        } catch (e) {
          // File may not exist — that's fine, ignore NotFoundError.
        }
        opfsFile = await opfsRoot.getFileHandle(filename, { create: true });
        opfsAccess = await opfsFile.createSyncAccessHandle();
        opfsAccess.truncate(0);
        return true;
      } catch (e) {
        console.error('[ARE] OPFS init failed, falling back to in-memory array:', e);
        fallbackMode = true;
        initError = e;
        opfsRoot = null;
        opfsFile = null;
        opfsAccess = null;
        return false;
      }
    }

    /**
     * Re-open an existing capture file (post-SW-restart path). The file is
     * preserved — the caller can then decide to keep it (resume) or clear
     * it. This function does NOT truncate; it just re-acquires the handles.
     *
     * @returns {Promise<boolean>} true if the file existed and was re-opened
     */
    async function restoreFromExisting() {
      opfsBytesWritten = 0;
      inMemoryCount = 0;
      fallbackMode = false;
      initError = null;
      opfsRoot = null;
      opfsFile = null;
      opfsAccess = null;

      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
        fallbackMode = true;
        initError = new Error('navigator.storage.getDirectory is not available');
        return false;
      }

      try {
        opfsRoot = await nav.storage.getDirectory();
        var exists = true;
        try {
          await opfsRoot.getFileHandle(filename);
        } catch (e) {
          exists = false;
        }
        if (!exists) {
          // Nothing to restore — caller should call init() to start fresh.
          return false;
        }
        opfsFile = await opfsRoot.getFileHandle(filename);
        opfsAccess = await opfsFile.createSyncAccessHandle();
        // Read existing byte length so subsequent appends continue from the end.
        opfsBytesWritten = opfsAccess.getSize();
        return true;
      } catch (e) {
        console.error('[ARE] OPFS restore failed:', e);
        fallbackMode = true;
        initError = e;
        opfsRoot = null;
        opfsFile = null;
        opfsAccess = null;
        return false;
      }
    }

    /**
     * Append a single entry as one JSONL line (LF terminated).
     * @param {Object} entry
     * @returns {boolean} true on success, false on failure (caller continues
     *                    with the fallback path if applicable)
     */
    function append(entry) {
      if (fallbackMode) {
        // Caller should never call us in fallback mode — but be defensive.
        inMemoryCount += 1;
        return false;
      }
      if (!opfsAccess) {
        console.error('[ARE] OPFS append called before init/restore');
        return false;
      }
      try {
        var line = JSON.stringify(entry) + '\n';
        var encoded = new TextEncoder().encode(line);
        opfsAccess.write(encoded, { at: opfsBytesWritten });
        opfsBytesWritten += encoded.byteLength;
        inMemoryCount += 1;
        return true;
      } catch (e) {
        console.error('[ARE] OPFS write failed:', e);
        return false;
      }
    }

    /**
     * Get a File object representing the capture file. Used by the download
     * path: `await file.arrayBuffer()` → Blob → URL.createObjectURL.
     * @returns {Promise<File>}
     */
    async function getFile() {
      if (!opfsFile) {
        throw new Error('OPFS file handle is not open — call init() first');
      }
      return await opfsFile.getFile();
    }

    /**
     * Close the access handle (for STOP). The file handle is kept so a
     * subsequent `restoreFromExisting()` or `getFile()` can re-acquire it.
     */
    function close() {
      if (opfsAccess) {
        try {
          opfsAccess.close();
        } catch (e) {
          // Best-effort.
        }
        opfsAccess = null;
      }
    }

    /**
     * Close + remove the file. Used by CLEAR. Resets all state.
     */
    async function clear() {
      close();
      if (opfsRoot && filename) {
        try {
          await opfsRoot.removeEntry(filename);
        } catch (e) {
          // File may not exist; ignore.
        }
      }
      opfsFile = null;
      opfsRoot = null;
      opfsBytesWritten = 0;
      inMemoryCount = 0;
    }

    return {
      init: init,
      append: append,
      getFile: getFile,
      getCount: getCount,
      getBytesWritten: getBytesWritten,
      getError: getError,
      clear: clear,
      close: close,
      restoreFromExisting: restoreFromExisting,
      isOpen: isOpen,
      inFallbackMode: inFallback,
      // Exposed for tests + advanced introspection.
      _filename: filename
    };
  }

  return {
    createOpfsBuffer: createOpfsBuffer,
    DEFAULT_FILENAME: DEFAULT_FILENAME
  };
}));
