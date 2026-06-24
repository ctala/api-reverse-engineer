/**
 * API Reverse Engineer — OPFS Streaming Buffer (async write path, ADR-0003)
 *
 * ADR-0003 supersedes the sync-handle design of ADR-0002. Empirically,
 * `FileSystemFileHandle.createSyncAccessHandle()` is NOT available in MV3
 * service workers (only in dedicated workers) — it threw, so the extension
 * silently ran in memory-fallback the whole time and never persisted to disk.
 *
 * This module now uses the ASYNC OPFS API, which DOES work in a service
 * worker:
 *   - writes via `FileSystemFileHandle.createWritable({keepExistingData:true})`
 *     + `seek(end)` + `write(line)` + `close()`,
 *   - reads via `getFile()` + `File.text()`/`arrayBuffer()`.
 *
 * Appends are BATCHED: `append()` stays synchronous (pushes the line to a
 * pending queue and returns true immediately, so the CAPTURE hot-path is
 * unchanged), and a microtask-scheduled `_flush()` drains the queue to disk in
 * one writable session. `flush()` forces durability (called before reads and
 * on STOP/PAUSE) so a recording survives the SW being killed (pausa/continuar).
 *
 * Loaded two ways:
 *   - Chrome extension service worker (classic script): attaches `self.OpfsBuffer`.
 *   - Node tests (CJS via createRequire): returns `module.exports`.
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
  } else if (typeof self !== 'undefined') {
    // Service-worker context: no window, no module. Attach to the worker global
    // so background.js (which reads self.OpfsBuffer) finds it after importScripts.
    self.OpfsBuffer = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.OpfsBuffer = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_FILENAME = 'captures.jsonl';

  /**
   * Create a new OPFS buffer instance.
   * @param {Object} opts
   * @param {string} [opts.filename='captures.jsonl']
   * @param {Object} [opts.navigator] — injectable for tests; defaults to globalThis.navigator
   * @returns {Object} buffer instance
   */
  function createOpfsBuffer(opts) {
    opts = opts || {};
    var filename = opts.filename || DEFAULT_FILENAME;
    var nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : null);

    var opfsRoot = null;
    var opfsFile = null;       // FileSystemFileHandle (async)
    var opened = false;
    var fallbackMode = false;
    var initError = null;

    var diskBytes = 0;         // bytes committed to disk
    var diskCount = 0;         // lines committed to disk (also the fallback counter)
    var pending = [];          // line strings not yet written
    var pendingBytes = 0;      // byte length of pending
    var flushing = false;
    var flushScheduled = false;

    function _enc(s) { return new TextEncoder().encode(s); }

    function isOpen() { return opened && !fallbackMode; }
    function inFallback() { return fallbackMode; }
    function getCount() { return diskCount + pending.length; }
    function getBytesWritten() { return diskBytes + pendingBytes; }
    function getError() { return initError; }

    function _resetState() {
      opfsRoot = null; opfsFile = null; opened = false;
      fallbackMode = false; initError = null;
      diskBytes = 0; diskCount = 0; pending = []; pendingBytes = 0;
      flushing = false; flushScheduled = false;
    }

    function _countLines(text) {
      if (!text) return 0;
      var n = 0;
      for (var i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) n++; }
      return n;
    }

    /**
     * Open (or create) the capture file, TRUNCATING any existing one.
     * START = new session (ADR-0003: truncate only on START / CLEAR).
     * @returns {Promise<boolean>} true on success, false on fallback
     */
    async function init() {
      _resetState();
      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
        fallbackMode = true;
        initError = new Error('navigator.storage.getDirectory is not available');
        return false;
      }
      try {
        opfsRoot = await nav.storage.getDirectory();
        opfsFile = await opfsRoot.getFileHandle(filename, { create: true });
        // createWritable() WITHOUT keepExistingData starts empty → close truncates.
        var w = await opfsFile.createWritable();
        await w.close();
        diskBytes = 0; diskCount = 0;
        opened = true;
        return true;
      } catch (e) {
        console.error('[ARE] OPFS init failed, falling back to in-memory array:', e);
        fallbackMode = true; initError = e;
        opfsRoot = null; opfsFile = null; opened = false;
        return false;
      }
    }

    /**
     * Re-open an existing capture file WITHOUT truncating (resume / SW-restart).
     * Reads the current size + line count so getCount()/getBytesWritten() and
     * subsequent appends continue from the end. ADR-0003.
     * @returns {Promise<boolean>} true if the file existed and was re-opened
     */
    async function restoreFromExisting() {
      _resetState();
      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
        fallbackMode = true;
        initError = new Error('navigator.storage.getDirectory is not available');
        return false;
      }
      try {
        opfsRoot = await nav.storage.getDirectory();
        try {
          opfsFile = await opfsRoot.getFileHandle(filename);
        } catch (e) {
          opfsFile = null;
          return false; // nothing to restore — caller should init() fresh
        }
        var f = await opfsFile.getFile();
        var text = await f.text();
        diskBytes = (typeof f.size === 'number') ? f.size : _enc(text).byteLength;
        diskCount = _countLines(text);
        opened = true;
        return true;
      } catch (e) {
        console.error('[ARE] OPFS restore failed:', e);
        fallbackMode = true; initError = e;
        opfsRoot = null; opfsFile = null; opened = false;
        return false;
      }
    }

    /**
     * Queue one entry as a JSONL line. SYNCHRONOUS: pushes to the pending
     * buffer and schedules a batched flush. Returns true on success, false in
     * fallback mode / before init (the caller then uses the memory buffer).
     */
    function append(entry) {
      if (fallbackMode) {
        // Keep the counter moving so the caller can stay in sync (old contract).
        diskCount += 1;
        return false;
      }
      if (!opfsFile) return false;
      var line = JSON.stringify(entry) + '\n';
      pending.push(line);
      pendingBytes += _enc(line).byteLength;
      _scheduleFlush();
      return true;
    }

    function _scheduleFlush() {
      if (flushScheduled || flushing) return;
      flushScheduled = true;
      Promise.resolve().then(function () { _flush(); });
    }

    async function _flush() {
      flushScheduled = false;
      if (flushing || !opfsFile || pending.length === 0) return;
      flushing = true;
      var batch = pending;
      pending = [];
      var data = batch.join('');
      var batchBytes = _enc(data).byteLength;
      try {
        var w = await opfsFile.createWritable({ keepExistingData: true });
        if (typeof w.seek === 'function') await w.seek(diskBytes);
        await w.write(data);
        await w.close();
        diskBytes += batchBytes;
        diskCount += batch.length;
        pendingBytes -= batchBytes;
        if (pendingBytes < 0) pendingBytes = 0;
      } catch (e) {
        console.error('[ARE] OPFS flush failed, re-queueing batch:', e);
        pending = batch.concat(pending); // don't lose data on a transient failure
      } finally {
        flushing = false;
        if (pending.length) _scheduleFlush();
      }
    }

    /**
     * Force everything pending to disk. Awaited before reads and on STOP/PAUSE
     * so the data is durable before the SW may be killed.
     * @returns {Promise<void>}
     */
    async function flush() {
      var guard = 0;
      while ((pending.length > 0 || flushing) && guard < 100000) {
        guard += 1;
        if (flushing) {
          await new Promise(function (r) { setTimeout(r, 0); });
          continue;
        }
        await _flush();
      }
    }

    /**
     * Get a File object for download. Flushes pending writes first so the file
     * reflects every captured event.
     * @returns {Promise<File>}
     */
    async function getFile() {
      if (!opfsFile) {
        throw new Error('OPFS file handle is not open — call init() first');
      }
      await flush();
      return await opfsFile.getFile();
    }

    /**
     * Read the whole committed file as text (used by the resume path to rebuild
     * the dedup set). Flushes pending writes first.
     * @returns {Promise<string>}
     */
    async function readAll() {
      if (!opfsFile) return '';
      await flush();
      try {
        var f = await opfsFile.getFile();
        return await f.text();
      } catch (e) {
        console.error('[ARE] OPFS readAll failed:', e);
        return '';
      }
    }

    /**
     * Mark the buffer closed (STOP/PAUSE). The async model holds no handle open,
     * but we kick a best-effort flush so the tail is persisted before the SW may
     * die. The file persists for a later getFile()/restoreFromExisting().
     */
    function close() {
      opened = false;
      _flush();
    }

    /**
     * Close + remove the file. Used by CLEAR. Resets all state.
     */
    async function clear() {
      pending = []; pendingBytes = 0;
      if (opfsRoot && filename) {
        try {
          await opfsRoot.removeEntry(filename);
        } catch (e) {
          // File may not exist; ignore.
        }
      }
      opfsFile = null; opfsRoot = null; opened = false;
      diskBytes = 0; diskCount = 0;
    }

    return {
      init: init,
      append: append,
      flush: flush,
      getFile: getFile,
      getCount: getCount,
      getBytesWritten: getBytesWritten,
      getError: getError,
      clear: clear,
      close: close,
      restoreFromExisting: restoreFromExisting,
      readAll: readAll,
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
