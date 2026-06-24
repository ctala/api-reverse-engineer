/**
 * API Reverse Engineer v1.4.0 — MemoryBuffer (fallback) tests
 *
 * Covers the MemoryBuffer module (src/memory-buffer.js). Mirrors the
 * OpfsBuffer API surface so the same `.append()` / `.getCount()` /
 * `.clear()` shape works in both buffer backends.
 *
 * Run: `node test/memory-buffer.test.mjs` from the repo root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMemoryBuffer, DEFAULT_MAX_BYTES } = require('../src/memory-buffer.js');

test('MemoryBuffer: DEFAULT_MAX_BYTES is 50 MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
});

test('MemoryBuffer: inFallbackMode() is true by definition', () => {
  const b = createMemoryBuffer();
  assert.equal(b.inFallbackMode(), true);
});

test('MemoryBuffer: append + getCount tracks entries', () => {
  const b = createMemoryBuffer();
  assert.equal(b.getCount(), 0);
  assert.equal(b.append({ url: 'https://x.test/1', method: 'GET' }), true);
  assert.equal(b.getCount(), 1);
  assert.equal(b.append({ url: 'https://x.test/2', method: 'POST' }), true);
  assert.equal(b.getCount(), 2);
});

test('MemoryBuffer: snapshot() returns a copy of the array', () => {
  const b = createMemoryBuffer();
  b.append({ url: 'https://x.test/1', method: 'GET', n: 1 });
  b.append({ url: 'https://x.test/2', method: 'GET', n: 2 });
  const snap = b.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].n, 1);
  assert.equal(snap[1].n, 2);
  // Mutating the snapshot must not affect the buffer.
  snap.push({ url: 'fake', method: 'GET' });
  assert.equal(b.getCount(), 2, 'snapshot mutation must not affect buffer');
});

test('MemoryBuffer: clear() empties the buffer', () => {
  const b = createMemoryBuffer();
  b.append({ url: 'https://x.test/1', method: 'GET' });
  b.append({ url: 'https://x.test/2', method: 'GET' });
  b.clear();
  assert.equal(b.getCount(), 0);
  assert.equal(b.getBytesWritten(), 0);
  assert.equal(b.snapshot().length, 0);
});

test('MemoryBuffer: FIFO eviction when byte cap exceeded', () => {
  // Use a small cap so we can hit it quickly.
  const b = createMemoryBuffer({ maxBytes: 1024 }); // 1 KB
  // Each entry is ~256 bytes (overhead) + 800 char body ≈ 1.1 KB.
  for (let i = 0; i < 20; i++) {
    b.append({
      url: 'https://x.test/' + i,
      method: 'POST',
      body: 'x'.repeat(800)
    });
  }
  // The buffer should have evicted the oldest entries to stay under the cap.
  assert.ok(b.getCount() < 20, 'some entries must be evicted');
  assert.ok(b.getBytesWritten() <= 1024 + 1100, 'byte cap is respected (allow slight overshoot for the last entry)');
});

test('MemoryBuffer: isOpen() always true (in-memory is always available)', () => {
  const b = createMemoryBuffer();
  assert.equal(b.isOpen(), true);
});

test('MemoryBuffer: getBytesWritten() tracks approximate footprint', () => {
  const b = createMemoryBuffer();
  b.append({ url: 'https://x.test/long-url-with-some-extra-characters', method: 'GET' });
  b.append({ url: 'https://x.test/short', method: 'GET', body: 'abc' });
  assert.ok(b.getBytesWritten() > 0);
  b.clear();
  assert.equal(b.getBytesWritten(), 0);
});
