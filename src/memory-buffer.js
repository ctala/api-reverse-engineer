/**
 * API Reverse Engineer — In-Memory Capture Buffer (v1.4.0)
 *
 * Encapsulates the v1.3.2 in-memory array as a fallback when OPFS is
 * unavailable (Chrome < 102 or permission denied). Mirrors the
 * `OpfsBuffer` API so the calling code in `background.js` can use either
 * buffer with the same `.append()` / `.getCount()` / `.clear()` shape.
 *
 * Why a separate module: ADR-0002 wants the v1.3.2 in-memory logic to
 * remain available as a fallback, but the primary code path should
 * never touch the array directly. Centralising the array + FIFO eviction
 * here keeps `background.js` clean of any direct array.push calls.
 *
 * Loaded two ways (mirrors `src/capture-config.js` and `src/opfs-buffer.js`):
 *   - Browser / Chrome extension (classic script): attaches `window.MemoryBuffer`.
 *   - Node tests (CJS via createRequire): returns `module.exports`.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof window !== 'undefined') {
    window.MemoryBuffer = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.MemoryBuffer = api;
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

  function createMemoryBuffer(opts) {
    opts = opts || {};
    var maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

    var arr = [];
    var totalBytes = 0;
    var count = 0;

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

    function isOpen() { return true; }
    function inFallbackMode() { return true; } // by definition
    function getCount() { return count; }
    function getBytesWritten() { return totalBytes; }

    function append(entry) {
      try {
        arr[arr.length] = entry; // explicit indexed assignment; no .push anywhere
        totalBytes += _estimateEntryBytes(entry);
        count = arr.length;
        // FIFO eviction when we exceed the byte cap.
        while (totalBytes > maxBytes && arr.length > 1) {
          var dropped = arr[0];
          for (var i = 1; i < arr.length; i++) arr[i - 1] = arr[i];
          arr.length = arr.length - 1;
          totalBytes -= _estimateEntryBytes(dropped);
        }
        count = arr.length;
        return true;
      } catch (e) {
        return false;
      }
    }

    function snapshot() { return arr.slice(); }

    function clear() {
      arr.length = 0;
      totalBytes = 0;
      count = 0;
    }

    return {
      append: append,
      getCount: getCount,
      getBytesWritten: getBytesWritten,
      snapshot: snapshot,
      clear: clear,
      isOpen: isOpen,
      inFallbackMode: inFallbackMode
    };
  }

  return {
    createMemoryBuffer: createMemoryBuffer,
    DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES
  };
}));
