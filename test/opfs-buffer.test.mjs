/**
 * API Reverse Engineer v1.4.0 — OPFS streaming buffer tests
 *
 * Covers the OpfsBuffer module (src/opfs-buffer.js) per ADR-0002.
 * Tests run with `node:test` (Node 20+). The OPFS API
 * (`navigator.storage.getDirectory`, `getFileHandle`, `createSyncAccessHandle`,
 * `FileSystemSyncAccessHandle.write`/`close`/`truncate`/`getSize`,
 * `File.getBlob`/`getFile`) is mocked per-test.
 *
 * Run: `node test/opfs-buffer.test.mjs` from the repo root.
 *
 * The source under test is a UMD classic/CJS module — we load it via
 * `createRequire` to keep the test file ESM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOpfsBuffer, DEFAULT_FILENAME } = require('../src/opfs-buffer.js');

// Silence the expected console.error output from the OpfsBuffer when it
// degrades to fallback mode (tested explicitly below). We restore the
// real console.error after the test run.
const realConsoleError = console.error;
console.error = function (...args) {
  const msg = String(args[0] || '');
  if (msg.startsWith('[ARE]')) return; // suppress intentional log lines from OpfsBuffer
  realConsoleError.apply(console, args);
};

// ---------------------------------------------------------------------------
// Mock helpers — small in-memory OPFS implementation
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory OPFS mock for one test. Each test gets its own
 * instance to avoid cross-test contamination.
 */
function makeOpfsMock() {
  // The "directory" is a Map<name, {kind: 'file'|'dir', data?: Uint8Array}>.
  const dir = new Map();
  const writes = []; // ordered list of writes for introspection
  let currentSize = 0;

  function makeFileHandle(name) {
    return {
      kind: 'file',
      name,
      // OPFS FileSystemFileHandle.getFile()
      async getFile() {
        const existing = dir.get(name);
        if (!existing || existing.kind !== 'file') {
          throw new Error('NotFoundError: file does not exist: ' + name);
        }
        const data = existing.data || new Uint8Array(0);
        // Return a File-like object with arrayBuffer() and size.
        return {
          name,
          size: data.byteLength,
          async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
          async text() { return new TextDecoder().decode(data); }
        };
      },
      // OPFS FileSystemFileHandle.createWritable() — the async write API that
      // actually exists in MV3 service workers (createSyncAccessHandle does NOT).
      async createWritable(opts) {
        const keep = !!(opts && opts.keepExistingData);
        const existing = dir.get(name);
        let data = (keep && existing && existing.data) ? existing.data.slice() : new Uint8Array(0);
        let pos = 0;
        return {
          async seek(p) { pos = p; },
          async write(chunk) {
            const bytes = typeof chunk === 'string'
              ? new TextEncoder().encode(chunk)
              : new Uint8Array(chunk.buffer || chunk);
            const end = pos + bytes.byteLength;
            if (end > data.byteLength) {
              const next = new Uint8Array(end);
              next.set(data, 0);
              data = next;
            }
            data.set(bytes, pos);
            pos = end;
            writes.push({ at: end - bytes.byteLength, length: bytes.byteLength });
          },
          async truncate(size) { data = data.slice(0, size); if (pos > size) pos = size; },
          async close() { dir.set(name, { kind: 'file', data }); currentSize = data.byteLength; }
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
    // Test introspection.
    _dir: dir,
    _writes: writes
  };

  const navigator = {
    storage: { getDirectory: async () => root }
  };

  return { root, navigator, dir, writes, getSize: () => currentSize };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('OpfsBuffer: DEFAULT_FILENAME is captures.jsonl', () => {
  assert.equal(DEFAULT_FILENAME, 'captures.jsonl');
});

test('OpfsBuffer: navigator.storage.getDirectory returns the mocked directory handle', async () => {
  const { navigator, root } = makeOpfsMock();
  const dir = await navigator.storage.getDirectory();
  assert.equal(typeof dir.getFileHandle, 'function');
  assert.equal(typeof dir.removeEntry, 'function');
  // The returned root is our mock.
  assert.equal(dir, root);
});

test('OpfsBuffer: createSyncAccessHandle().write() writes to the mock buffer', async () => {
  const { navigator } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  const ok = await buf.init();
  assert.equal(ok, true);
  assert.equal(buf.isOpen(), true);
  assert.equal(buf.inFallbackMode(), false);

  const wrote = buf.append({ url: 'https://x.test/a', method: 'GET', status: 200 });
  assert.equal(wrote, true);
  assert.equal(buf.getCount(), 1);
  assert.ok(buf.getBytesWritten() > 0, 'bytes should have been written');
});

test('OPFS path: 100 events produce 100 JSONL lines, each parses as JSON', async () => {
  const { navigator, dir } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  await buf.init();

  for (let i = 0; i < 100; i++) {
    const ok = buf.append({
      method: 'GET',
      url: 'https://api.linkedin.com/voyager/api/me/' + i,
      status: 200,
      timestamp: '2026-06-24T12:00:00.' + String(i).padStart(3, '0') + 'Z',
      payload: { idx: i, nested: { value: i * 2 } }
    });
    assert.equal(ok, true);
  }

  assert.equal(buf.getCount(), 100);

  // Flush by closing the access handle so getFile() sees the latest data.
  buf.close();

  // Re-open via getFile (which uses the file handle, not access handle).
  const file = await buf.getFile();
  const ab = await file.arrayBuffer();
  const text = new TextDecoder().decode(ab);
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 100, 'expected 100 JSONL lines');

  // Each line must parse as JSON and round-trip the field we wrote.
  for (let i = 0; i < 100; i++) {
    const obj = JSON.parse(lines[i]);
    assert.equal(obj.method, 'GET');
    assert.equal(obj.url, 'https://api.linkedin.com/voyager/api/me/' + i);
    assert.equal(obj.status, 200);
    assert.equal(obj.payload.idx, i);
  }
});

test('OPFS download: blob byte size equals sum of encoded line sizes', async () => {
  const { navigator } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  await buf.init();

  const entries = [];
  for (let i = 0; i < 25; i++) {
    const e = {
      method: 'POST',
      url: 'https://api.linkedin.com/voyager/api/feed/' + i,
      status: 201,
      body: { foo: 'bar-' + i, count: i }
    };
    entries.push(e);
    buf.append(e);
  }
  buf.close();

  const file = await buf.getFile();
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);

  // Sum of expected line sizes (each line = JSON.stringify(entry) + '\n').
  const expectedBytes = entries.reduce((acc, e) => acc + (JSON.stringify(e) + '\n').length, 0);
  assert.equal(bytes.byteLength, expectedBytes, 'blob size must match sum of JSONL line sizes');
});

test('Fallback path: OPFS unavailable → inFallbackMode() true, append returns false', async () => {
  // Pass a navigator WITHOUT storage.getDirectory (simulates Chrome < 102).
  const buf = createOpfsBuffer({ navigator: { storage: {} } });
  const ok = await buf.init();
  assert.equal(ok, false, 'init should signal failure');
  assert.equal(buf.inFallbackMode(), true);
  assert.equal(buf.isOpen(), false);

  // Caller is expected to detect fallback and write to the in-memory array
  // itself (background.js does this). OpfsBuffer.append returns false in
  // fallback mode.
  const wrote = buf.append({ url: 'https://x', method: 'GET' });
  assert.equal(wrote, false);
  // getCount() still increments so the caller can keep its own counter in sync.
  assert.equal(buf.getCount(), 1);
});

test('Fallback path: navigator = null (extreme case) → fallback', async () => {
  const buf = createOpfsBuffer({ navigator: null });
  const ok = await buf.init();
  assert.equal(ok, false);
  assert.equal(buf.inFallbackMode(), true);
  assert.equal(buf.isOpen(), false);
});

test('Fallback path: getDirectory throws → fallback, error captured', async () => {
  const navigator = {
    storage: {
      getDirectory: async () => { throw new Error('SecurityError: OPFS access denied'); }
    }
  };
  const buf = createOpfsBuffer({ navigator });
  const ok = await buf.init();
  assert.equal(ok, false);
  assert.equal(buf.inFallbackMode(), true);
  assert.ok(buf.getError() instanceof Error);
  assert.match(buf.getError().message, /OPFS access denied/);
});

test('CLEAR removes the OPFS file and resets state', async () => {
  const { navigator, dir } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  await buf.init();
  buf.append({ url: 'https://x.test/1', method: 'GET' });
  buf.append({ url: 'https://x.test/2', method: 'POST' });
  assert.equal(buf.getCount(), 2);
  assert.ok(dir.has('captures.jsonl'), 'file should exist before clear');

  await buf.clear();
  assert.equal(dir.has('captures.jsonl'), false, 'file should be removed after clear');
  assert.equal(buf.getCount(), 0, 'counter reset');
  assert.equal(buf.getBytesWritten(), 0, 'bytes reset');
  assert.equal(buf.isOpen(), false, 'access handle closed');
});

test('SW restart mid-session: file persists, restoreFromExisting re-opens', async () => {
  const { navigator, dir } = makeOpfsMock();

  // Session 1: write 5 events, then simulate SW kill by closing the handle.
  const buf1 = createOpfsBuffer({ navigator });
  await buf1.init();
  for (let i = 0; i < 5; i++) {
    buf1.append({ url: 'https://x.test/s1/' + i, method: 'GET' });
  }
  buf1.close(); // SW dies here, but the file persists.

  // The file should still be on disk.
  assert.ok(dir.has('captures.jsonl'));
  const fileBeforeRestart = await (await buf1.getFile()).arrayBuffer();
  const textBefore = new TextDecoder().decode(fileBeforeRestart);
  assert.equal(textBefore.split('\n').filter((l) => l.length > 0).length, 5);

  // Session 2: a fresh buffer instance (the new SW) must be able to
  // restore the file WITHOUT truncating. (Truncation only happens on
  // explicit `init()` per ADR-0002 fresh-start policy.)
  const buf2 = createOpfsBuffer({ navigator });
  const restored = await buf2.restoreFromExisting();
  assert.equal(restored, true, 'restoreFromExisting should succeed');
  assert.equal(buf2.isOpen(), true);
  // The pre-existing 5 events are on disk; the new buffer can append to
  // them, starting at the existing byte offset.
  buf2.append({ url: 'https://x.test/s2/1', method: 'GET' });
  buf2.close();

  const fileAfterRestart = await (await buf2.getFile()).arrayBuffer();
  const textAfter = new TextDecoder().decode(fileAfterRestart);
  const lines = textAfter.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 6, 'expected 5 pre-existing + 1 new event = 6 lines');
  // First line is from session 1.
  assert.match(lines[0], /s1\/0/);
  // Last line is from session 2.
  assert.match(lines[5], /s2\/1/);
});

test('SW restart when no file exists: restoreFromExisting returns false, init() works', async () => {
  const { navigator, dir } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  const restored = await buf.restoreFromExisting();
  assert.equal(restored, false, 'no file → restore returns false');
  assert.equal(buf.isOpen(), false);
  // Caller can then init() a fresh session.
  const ok = await buf.init();
  assert.equal(ok, true);
  assert.equal(dir.has('captures.jsonl'), true);
});

test('Multi-tab: each OpfsBuffer instance has its own handle, files share directory', async () => {
  const { navigator, dir } = makeOpfsMock();
  const tab1 = createOpfsBuffer({ navigator, filename: 'captures-tab1.jsonl' });
  const tab2 = createOpfsBuffer({ navigator, filename: 'captures-tab2.jsonl' });

  await tab1.init();
  tab1.append({ url: 'https://tab1.test/a', method: 'GET' });
  tab1.append({ url: 'https://tab1.test/b', method: 'GET' });

  await tab2.init();
  tab2.append({ url: 'https://tab2.test/a', method: 'GET' });

  assert.equal(dir.has('captures-tab1.jsonl'), true);
  assert.equal(dir.has('captures-tab2.jsonl'), true);
  assert.equal(tab1.getCount(), 2);
  assert.equal(tab2.getCount(), 1);

  // Each file is isolated — reading tab1 doesn't return tab2's events.
  tab1.close();
  tab2.close();
  const f1 = await (await tab1.getFile()).arrayBuffer();
  const f2 = await (await tab2.getFile()).arrayBuffer();
  const t1 = new TextDecoder().decode(f1);
  const t2 = new TextDecoder().decode(f2);
  assert.match(t1, /tab1\.test/);
  assert.ok(!t1.includes('tab2.test'), 'tab1 file must not contain tab2 events');
  assert.match(t2, /tab2\.test/);
  assert.ok(!t2.includes('tab1.test'), 'tab2 file must not contain tab1 events');
});

test('OpfsBuffer: close() is idempotent and safe to call before init', () => {
  const { navigator } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  // Never init'd — close is a no-op, must not throw.
  buf.close();
  buf.close();
  assert.equal(buf.isOpen(), false);
});

test('OpfsBuffer: append before init() returns false and does not throw', () => {
  const { navigator } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  const wrote = buf.append({ url: 'https://x', method: 'GET' });
  assert.equal(wrote, false);
  assert.equal(buf.isOpen(), false);
});

test('OpfsBuffer: init() truncates any pre-existing file (fresh start policy)', async () => {
  const { navigator, dir } = makeOpfsMock();
  // Pre-populate the file (simulates "previous session left data behind").
  const pre = new TextEncoder().encode('{"old":true}\n{"old":true}\n');
  dir.set('captures.jsonl', { kind: 'file', data: pre });

  const buf = createOpfsBuffer({ navigator });
  const ok = await buf.init();
  assert.equal(ok, true);
  buf.append({ url: 'https://fresh', method: 'GET' });
  buf.close();

  const file = await buf.getFile();
  const text = new TextDecoder().decode(await file.arrayBuffer());
  // Old lines must be gone — only the new event remains.
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /fresh/);
  assert.ok(!text.includes('"old":true'), 'old data must be truncated away');
});

test('OpfsBuffer: large event payload (5 MB body) does not throw', async () => {
  const { navigator } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  await buf.init();
  const bigBody = 'x'.repeat(5 * 1024 * 1024); // 5 MB
  const wrote = buf.append({
    url: 'https://huge.test/api',
    method: 'POST',
    status: 200,
    body: bigBody
  });
  assert.equal(wrote, true);
  assert.equal(buf.getCount(), 1);
  assert.ok(buf.getBytesWritten() >= 5 * 1024 * 1024, 'bytes should reflect 5MB+ payload');
  buf.close();
});

test('OpfsBuffer: cleared buffer can be re-initialised for a new session', async () => {
  const { navigator, dir } = makeOpfsMock();
  const buf = createOpfsBuffer({ navigator });
  await buf.init();
  buf.append({ url: 'https://a', method: 'GET' });
  await buf.clear();
  assert.equal(dir.has('captures.jsonl'), false);

  // Start a new session on the same instance.
  await buf.init();
  buf.append({ url: 'https://b', method: 'GET' });
  buf.close();
  const file = await buf.getFile();
  const text = new TextDecoder().decode(await file.arrayBuffer());
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /https:\/\/b/);
});
