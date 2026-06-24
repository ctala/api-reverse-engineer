/**
 * sw-wiring.test.mjs — the HONEST test.
 *
 * Loads the service worker the way Chrome loads it (only src/background.js,
 * via a real importScripts, WITHOUT pre-attaching globalThis.OpfsBuffer /
 * MemoryBuffer). This is the test the 71-green-but-broken suite never had.
 *
 * Before the B1 fix: background.js never importScripts its deps, so
 * self.OpfsBuffer / self.MemoryBuffer stay undefined → the SW captures
 * nothing → these tests FAIL (red). That red is the first honest signal
 * the project has ever produced: green now means "captures in real Chrome".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, makeOpfsMock } from './_chrome-mock.js';
import { makeSwContext, loadServiceWorker } from './_sw-loader.mjs';

function setup() {
  const ctx = installChromeMock();
  const opfs = makeOpfsMock();
  const sandbox = makeSwContext({ chrome: ctx.chrome, navigator: opfs.navigator });
  loadServiceWorker(sandbox); // loads ONLY background.js, like the manifest
  return { ctx, opfs, sandbox };
}

// Drive a message through the SW's onMessage listener and await the response.
function send(listener, msg, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => {
    const returned = listener(msg, sender, resolve);
    // Sync handlers call respond() before returning; async handlers return
    // true and call respond() later. If a handler does neither, don't hang.
    if (returned !== true) queueMicrotask(() => resolve(undefined));
  });
}

const tick = () => new Promise((r) => setImmediate(r));

test('B1 — el SW resuelve OpfsBuffer y MemoryBuffer cargado como en Chrome (sin pre-inyectar globals)', () => {
  const { sandbox } = setup();
  assert.ok(
    sandbox.OpfsBuffer && typeof sandbox.OpfsBuffer.createOpfsBuffer === 'function',
    'background.js debe cargar opfs-buffer.js vía importScripts y exponer self.OpfsBuffer'
  );
  assert.ok(
    sandbox.MemoryBuffer && typeof sandbox.MemoryBuffer.createMemoryBuffer === 'function',
    'background.js debe cargar memory-buffer.js vía importScripts y exponer self.MemoryBuffer'
  );
});

test('B1 — el SW registra el listener de onMessage', () => {
  const { ctx } = setup();
  assert.ok(typeof ctx.getMessageListener() === 'function', 'el SW debe registrar chrome.runtime.onMessage');
});

test('B1 — flujo real START → CAPTURE → DOWNLOAD captura ≥1 entry (sin globals pre-inyectados)', async () => {
  const { ctx } = setup();
  const listener = ctx.getMessageListener();
  assert.ok(listener, 'el SW debe registrar onMessage');

  await send(listener, { type: 'START', tabId: 1, outputFormat: 'jsonl' });
  await tick();
  await tick(); // dejar resolver el init async de OPFS

  await send(listener, {
    type: 'CAPTURE',
    entry: {
      method: 'POST',
      url: 'https://example.com/api/thing?x=1',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"a":1}',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"ok":true}',
      timestamp: '2026-06-24T00:00:00.000Z',
      duration: 10
    }
  });

  const state = await send(listener, { type: 'GET_STATE' });
  assert.equal(state.total, 1, 'GET_STATE.total debe ser 1 tras una captura (hoy es 0: buffers null)');

  const dl = await send(listener, { type: 'DOWNLOAD', format: 'jsonl' });
  assert.equal(dl.ok, true, 'DOWNLOAD no debe responder "No captures"');
  const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
  assert.match(jsonl, /example\.com\/api\/thing/, 'el JSONL descargado debe contener el endpoint capturado');
});
