/**
 * API Reverse Engineer v1.4.2 — Chrome API + OPFS mock helpers
 *
 * Shared mock setup for the background service-worker test harness
 * (test/background.test.mjs). The mocks are designed so the production
 * code under test (src/background.js) runs without modification.
 *
 * The mocks exposed here:
 *   - installChromeMock(opts?) — installs a `globalThis.chrome` object
 *     that records calls to setBadgeText, downloads, sendMessage, etc.
 *   - makeOpfsMock() — returns a fresh in-memory OPFS implementation
 *     (Map-based, similar to opfs-buffer.test.mjs).
 *   - makeDeferredOpfsMock() — same as above, but `getDirectory()` returns
 *     a Promise the test can resolve/reject at will (lets us simulate
 *     slow OPFS init and probe the race-condition window).
 *   - loadBackgroundFresh() — clears the require cache for src/* and
 *     returns a freshly-loaded background module + the captured message
 *     listener + the chrome.* calls log.
 *
 * Mock chrome.* surface (just enough to drive the test scenarios):
 *   - runtime.onMessage.addListener(fn)  — captured by the test
 *   - runtime.sendMessage(...)           — no-op
 *   - runtime.lastError                  — getter, defaults to null
 *   - tabs.query(opts, cb)               — returns [{ id: 1, windowId: 1 }]
 *   - tabs.sendMessage(tabId, msg, cb?)  — calls cb with {ready, version}
 *   - action.setBadgeText({text, tabId}) — recorded
 *   - action.setBadgeBackgroundColor     — recorded (no-op)
 *   - storage.session.get(keys, cb)      — in-memory
 *   - storage.session.set(payload)       — in-memory
 *   - storage.local.get/set/remove       — in-memory
 *   - scripting.executeScript            — Promise<undefined>
 *   - downloads.download(opts)           — recorded
 *
 * Privacy note: this mock lives in test/, never in src/. No secrets,
 * no real chrome.* access, no network.
 */
'use strict';

// ---------------------------------------------------------------------------
// Chrome API mock
// ---------------------------------------------------------------------------

/**
 * Install the chrome.* mock on globalThis. Returns the calls log so tests
 * can introspect what the SW did.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.storageSession] — pre-seeded session storage state
 * @returns {{chrome: Object, calls: {setBadge: Array, downloads: Array, sendMessage: Array, setStorageSession: Array, setStorageLocal: Array, queryTabs: Array, sendTabsMessage: Array, executeScript: Array}}}
 */
export function installChromeMock(opts) {
  opts = opts || {};
  const sessionStore = Object.assign({}, opts.storageSession || {});
  const localStore = {};
  const calls = {
    setBadge: [],
    setBadgeColor: [],
    downloads: [],
    sendMessage: [],
    setStorageSession: [],
    setStorageLocal: [],
    queryTabs: [],
    sendTabsMessage: [],
    executeScript: []
  };

  // chrome.runtime.lastError is a getter; tests that need to simulate
  // failure can call setLastError() to make the next sendMessage fail.
  let lastErrorVal = null;
  function setLastError(err) { lastErrorVal = err || null; }

  // The message listener will be captured by the background module
  // (via chrome.runtime.onMessage.addListener). We expose a slot.
  let messageListener = null;
  function captureListener(fn) { messageListener = fn; }

  const chrome = {
    runtime: {
      onMessage: { addListener: captureListener },
      sendMessage: function (...args) { calls.sendMessage.push(args); return Promise.resolve(); },
      get lastError() { return lastErrorVal; }
    },
    tabs: {
      query: function (q, cb) {
        calls.queryTabs.push(q);
        const tabs = [{ id: 1, url: 'https://www.linkedin.com/feed', windowId: 1 }];
        if (cb) setImmediate(() => cb(tabs));
        return Promise.resolve(tabs);
      },
      sendMessage: function (tabId, msg, cb) {
        calls.sendTabsMessage.push({ tabId, msg });
        // Simulate the content script responding to PING with {ready: true}.
        // Other message types get a generic ack (caller ignores it).
        const resp = (msg && msg.type === 'PING')
          ? { ready: true, version: '1.4.2' }
          : { ok: true };
        if (cb) setImmediate(() => cb(resp));
        return Promise.resolve(resp);
      }
    },
    action: {
      setBadgeText: function (o) { calls.setBadge.push(o); },
      setBadgeBackgroundColor: function (o) { calls.setBadgeColor.push(o); }
    },
    storage: {
      session: {
        get: function (keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(sessionStore));
          for (const k of list) {
            if (Object.prototype.hasOwnProperty.call(sessionStore, k)) {
              result[k] = sessionStore[k];
            }
          }
          if (cb) setImmediate(() => cb(result));
          return Promise.resolve(result);
        },
        set: function (payload) {
          Object.assign(sessionStore, payload);
          calls.setStorageSession.push(payload);
        },
        remove: function (keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete sessionStore[k];
        }
      },
      local: {
        get: function (keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(localStore));
          for (const k of list) {
            if (Object.prototype.hasOwnProperty.call(localStore, k)) {
              result[k] = localStore[k];
            }
          }
          if (cb) setImmediate(() => cb(result));
          return Promise.resolve(result);
        },
        set: function (payload) {
          Object.assign(localStore, payload);
          calls.setStorageLocal.push(payload);
        },
        remove: function (keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete localStore[k];
        }
      }
    },
    scripting: {
      executeScript: function (opts) {
        calls.executeScript.push(opts);
        return Promise.resolve();
      }
    },
    downloads: {
      download: function (opts) {
        calls.downloads.push(opts);
        return Promise.resolve(1);
      }
    }
  };

  globalThis.chrome = chrome;

  return {
    chrome,
    calls,
    sessionStore,
    localStore,
    setLastError,
    getMessageListener: function () { return messageListener; }
  };
}

// ---------------------------------------------------------------------------
// OPFS mock
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory OPFS mock for one test. The mock is shaped
 * like the OPFS sandbox navigator.storage.getDirectory returns:
 *   - getFileHandle(name, {create}) → fileHandle
 *   - fileHandle.getFile() → File-like (arrayBuffer)
 *   - fileHandle.createSyncAccessHandle() → access handle (write/truncate/getSize/close)
 *   - removeEntry(name) → unlink
 *
 * @returns {{navigator: Object, root: Object, dir: Map<string, {kind, data}>, writes: Array, getSize: () => number}}
 */
export function makeOpfsMock() {
  const dir = new Map();
  const writes = [];
  let currentSize = 0;

  function makeFileHandle(name) {
    return {
      kind: 'file',
      name,
      async getFile() {
        const existing = dir.get(name);
        if (!existing || existing.kind !== 'file') {
          throw new Error('NotFoundError: file does not exist: ' + name);
        }
        const data = existing.data || new Uint8Array(0);
        return {
          name,
          size: data.byteLength,
          async arrayBuffer() {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          }
        };
      },
      async createSyncAccessHandle() {
        return {
          write(buffer, opts) {
            const at = (opts && opts.at !== undefined) ? opts.at : currentSize;
            const existing = dir.get(name);
            const old = (existing && existing.data) || new Uint8Array(0);
            const newSize = Math.max(old.byteLength, at + buffer.byteLength);
            const next = new Uint8Array(newSize);
            next.set(old, 0);
            next.set(new Uint8Array(buffer), at);
            dir.set(name, { kind: 'file', data: next });
            currentSize = Math.max(currentSize, at + buffer.byteLength);
            writes.push({ at, length: buffer.byteLength, content: buffer });
          },
          truncate(size) {
            const existing = dir.get(name);
            const old = (existing && existing.data) || new Uint8Array(0);
            const next = old.slice(0, size);
            dir.set(name, { kind: 'file', data: next });
            currentSize = size;
          },
          getSize() {
            const existing = dir.get(name);
            return existing ? existing.data.byteLength : 0;
          },
          close() { /* no-op */ }
        };
      }
    };
  }

  const root = {
    async getFileHandle(name, opts) {
      const existing = dir.get(name);
      if (!existing) {
        if (opts && opts.create) {
          dir.set(name, { kind: 'file', data: new Uint8Array(0) });
          currentSize = 0;
          return makeFileHandle(name);
        }
        throw new Error('NotFoundError: ' + name);
      }
      if (existing.kind !== 'file') {
        throw new Error('TypeMismatchError: not a file: ' + name);
      }
      return makeFileHandle(name);
    },
    async removeEntry(name) {
      if (!dir.has(name)) throw new Error('NotFoundError: ' + name);
      dir.delete(name);
    },
    _dir: dir,
    _writes: writes
  };

  const navigator = {
    storage: { getDirectory: async () => root }
  };

  return { root, navigator, dir, writes, getSize: () => currentSize };
}

/**
 * Build a "deferred" OPFS mock where the test controls when getDirectory()
 * resolves. Lets us simulate slow OPFS init and probe the race-condition
 * window between START and the OPFS upgrade.
 *
 * @returns {{navigator: Object, root: Object, dir: Map, writes: Array, getSize: () => number, resolveInit: (val: any) => void, rejectInit: (err: Error) => void, isPending: () => boolean}}
 */
export function makeDeferredOpfsMock() {
  const dir = new Map();
  const writes = [];
  let currentSize = 0;
  let resolveInit, rejectInit;
  const initPromise = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });

  function makeFileHandle(name) {
    return {
      kind: 'file',
      name,
      async getFile() {
        const existing = dir.get(name);
        if (!existing || existing.kind !== 'file') {
          throw new Error('NotFoundError: file does not exist: ' + name);
        }
        const data = existing.data || new Uint8Array(0);
        return {
          name,
          size: data.byteLength,
          async arrayBuffer() {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          }
        };
      },
      async createSyncAccessHandle() {
        return {
          write(buffer, opts) {
            const at = (opts && opts.at !== undefined) ? opts.at : currentSize;
            const existing = dir.get(name);
            const old = (existing && existing.data) || new Uint8Array(0);
            const newSize = Math.max(old.byteLength, at + buffer.byteLength);
            const next = new Uint8Array(newSize);
            next.set(old, 0);
            next.set(new Uint8Array(buffer), at);
            dir.set(name, { kind: 'file', data: next });
            currentSize = Math.max(currentSize, at + buffer.byteLength);
            writes.push({ at, length: buffer.byteLength, content: buffer });
          },
          truncate(size) {
            const existing = dir.get(name);
            const old = (existing && existing.data) || new Uint8Array(0);
            const next = old.slice(0, size);
            dir.set(name, { kind: 'file', data: next });
            currentSize = size;
          },
          getSize() {
            const existing = dir.get(name);
            return existing ? existing.data.byteLength : 0;
          },
          close() { /* no-op */ }
        };
      }
    };
  }

  const root = {
    async getFileHandle(name, opts) {
      const existing = dir.get(name);
      if (!existing) {
        if (opts && opts.create) {
          dir.set(name, { kind: 'file', data: new Uint8Array(0) });
          currentSize = 0;
          return makeFileHandle(name);
        }
        throw new Error('NotFoundError: ' + name);
      }
      if (existing.kind !== 'file') {
        throw new Error('TypeMismatchError: not a file: ' + name);
      }
      return makeFileHandle(name);
    },
    async removeEntry(name) {
      if (!dir.has(name)) throw new Error('NotFoundError: ' + name);
      dir.delete(name);
    },
    _dir: dir,
    _writes: writes
  };

  // Slow getDirectory that only resolves when the test says so.
  const navigator = {
    storage: {
      getDirectory: function () {
        return initPromise.then(function (val) {
          if (val instanceof Error) throw val;
          return val === false ? Promise.reject(new Error('OPFS init aborted')) : root;
        });
      }
    }
  };

  return {
    navigator,
    root,
    dir,
    writes,
    getSize: () => currentSize,
    resolveInit: function (val) { resolveInit(val === undefined ? root : val); },
    rejectInit: function (err) { rejectInit(err || new Error('OPFS init failed')); },
    isPending: function () {
      // The promise itself doesn't expose a "pending" state, so we rely
      // on the test to track it via calls. The mock is single-use per test.
      return true;
    }
  };
}

/**
 * Build an OPFS mock that always fails (no getDirectory). Simulates
 * "OPFS unavailable" — Chrome < 102 or strict permissioning.
 *
 * @returns {{navigator: Object}}
 */
export function makeUnavailableOpfsMock() {
  return { navigator: { storage: {} } };
}

// ---------------------------------------------------------------------------
// Module loader — clears the require cache and re-loads the SW with mocks
// ---------------------------------------------------------------------------

/**
 * Load src/background.js with a fresh module cache. Each call returns a
 * pristine background module with no state carryover from previous tests.
 *
 * The OpfsBuffer and MemoryBuffer are loaded by the background module via
 * globalThis.{OpfsBuffer, MemoryBuffer}. We require them once here and
 * attach to globalThis BEFORE requiring background.js so the IIFE inside
 * background.js picks them up.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.chrome] — pre-seeded chrome.storage.session state
 * @param {Object} [opts.navigator] — pre-injected navigator mock for OPFS
 * @returns {{background: Object, listener: Function, chrome: Object, calls: Object, sessionStore: Object, localStore: Object, setLastError: Function}}
 */
export function loadBackgroundFresh(opts) {
  opts = opts || {};
  // Drop the require cache for the SW + its dependencies so each test
  // gets a fresh module evaluation (no carryover isRecording/counters).
  const { createRequire } = require('node:module');
  const localRequire = createRequire(import.meta.url);

  for (const path of [
    localRequire.resolve('../src/background.js'),
    localRequire.resolve('../src/opfs-buffer.js'),
    localRequire.resolve('../src/memory-buffer.js')
  ]) {
    delete localRequire.cache[path];
  }

  // Install chrome.* mock FIRST so the SW's top-level
  // `chrome.storage.session.get(...)` (the SW restore block) sees it.
  const ctx = installChromeMock(opts.chrome || {});

  // Inject the navigator mock BEFORE requiring the SW so OpfsBuffer picks
  // it up at module load time. Default to a working in-memory OPFS mock
  // so the OPFS path is exercised (rather than the unavailable path).
  // Node 20+ has a built-in `navigator` global with a read-only getter;
  // we use Object.defineProperty to override it.
  if (opts.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: opts.navigator,
      writable: true,
      configurable: true
    });
  } else {
    const opfsMock = makeOpfsMock();
    Object.defineProperty(globalThis, 'navigator', {
      value: opfsMock.navigator,
      writable: true,
      configurable: true
    });
    ctx.opfsMock = opfsMock;
  }

  // Attach OpfsBuffer + MemoryBuffer to globalThis so the SW IIFE picks
  // them up via `(typeof window !== 'undefined' && window.OpfsBuffer) ||
  // (typeof self !== 'undefined' && self.OpfsBuffer) || ...`.
  const { createOpfsBuffer } = localRequire('../src/opfs-buffer.js');
  const { createMemoryBuffer } = localRequire('../src/memory-buffer.js');
  globalThis.OpfsBuffer = { createOpfsBuffer };
  globalThis.MemoryBuffer = { createMemoryBuffer };

  // NOW require the SW. The IIFE runs, registers chrome.runtime.onMessage.
  const background = localRequire('../src/background.js');

  const listener = ctx.getMessageListener();
  if (!listener) {
    throw new Error('background.js did not register a message listener — chrome mock may be wrong');
  }

  return {
    background,
    listener,
    chrome: ctx.chrome,
    calls: ctx.calls,
    sessionStore: ctx.sessionStore,
    localStore: ctx.localStore,
    setLastError: ctx.setLastError
  };
}

// Node-side require() shim. ESM doesn't have `require` by default, but
// we only use it inside `loadBackgroundFresh` which is fine because the
// helper is called from an .mjs test file.
import { createRequire as _createRequire } from 'node:module';
const require = _createRequire(import.meta.url);
