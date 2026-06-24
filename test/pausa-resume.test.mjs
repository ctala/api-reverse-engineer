/**
 * pausa-resume.test.mjs — Fase 2 (pausa/continuar, durabilidad real).
 *
 * Estos tests son la red que faltaba para que una grabación sobreviva al
 * sleep del service worker MV3 y para los verbos PAUSE/RESUME. Antes de la
 * Fase 2, el SW al despertar perdía el buffer en memoria y dejaba el archivo
 * OPFS huérfano (B4), y DOWNLOAD abortaba "No captures" aunque hubiera datos
 * en disco (B5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpfsMock, loadBackgroundFresh } from './_chrome-mock.js';

function flushAsync() { return new Promise((r) => setImmediate(r)); }
async function flush(n = 6) { for (let i = 0; i < n; i++) await flushAsync(); }

async function sendMessage(ctx, msg, sender) {
  await flushAsync();
  return new Promise((resolve) => ctx.listener(msg, sender || { tab: { id: 1 } }, resolve));
}

const SENDER = { tab: { id: 1 } };

// Build an OPFS mock pre-populated with N raw-entry JSONL lines (the shape the
// SW writes to disk: {url, method, ...}). Simulates a captures.jsonl left on
// disk by a recording that the SW restart is about to resume.
function seedOpfs(n) {
  const mock = makeOpfsMock();
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ url: 'https://www.linkedin.com/voyager/api/feed/' + i, method: 'GET', status: 200, isNewEndpoint: true }));
  }
  const text = lines.join('\n') + (n ? '\n' : '');
  mock.dir.set('captures.jsonl', { kind: 'file', data: new TextEncoder().encode(text) });
  return mock;
}

test('Fase2/B4 — restore tras SW restart reconstruye contador + dedup desde el archivo', async () => {
  const opfs = seedOpfs(3);
  const ctx = loadBackgroundFresh({
    navigator: opfs.navigator,
    chrome: { storageSession: { isRecording: true, recordingTabId: 1, outputFormat: 'jsonl', filterMode: 'OR', sessionId: 's1' } },
  });
  await flush(); // correr restoreFromExisting + readAll

  let state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 3, 'el contador debe reconstruirse a 3 desde disco (v1.4.2 daba 0)');
  assert.equal(state.unique, 3, 'el dedup debe reconstruirse a 3 endpoints');
  assert.equal(state.isRecording, true);

  // Un CAPTURE nuevo CONTINÚA appendeando (4), no reinicia la sesión.
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: { url: 'https://www.linkedin.com/voyager/api/feed/NEW', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, responseBody: {} },
  }, SENDER);
  await flush(3);
  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 4, 'tras un CAPTURE post-restart el total debe ser 4 (continúa, no resetea)');

  // DOWNLOAD trae las 4 líneas (3 de disco + 1 nueva).
  await sendMessage(ctx, { type: 'STOP' }, SENDER);
  await flush(3);
  const dl = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER);
  assert.equal(dl.ok, true, 'DOWNLOAD no debe abortar tras restart con datos en disco');
  assert.equal(dl.lineCount, 4, 'el JSONL descargado debe tener 4 líneas');
});

test('Fase2 — restore sin archivo previo cae a memoria sin romper (no hay sesión que resumir)', async () => {
  // storageSession dice isRecording pero NO hay captures.jsonl en disco.
  const ctx = loadBackgroundFresh({
    chrome: { storageSession: { isRecording: true, recordingTabId: 1, outputFormat: 'jsonl', filterMode: 'OR' } },
  });
  await flush();
  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 0, 'sin archivo previo, el contador arranca en 0');
  assert.equal(state.isRecording, true);
});

test('Fase2/B3 — PAUSE no trunca y RESUME continúa appendeando (no resetea)', async () => {
  const opfs = makeOpfsMock();
  const ctx = loadBackgroundFresh({ navigator: opfs.navigator });
  await sendMessage(ctx, { type: 'START', tabId: 1, captureConfig: { patterns: [], filterMode: 'OR' } }, SENDER);
  await flush();

  const cap = (u) => sendMessage(ctx, {
    type: 'CAPTURE',
    entry: { url: u, method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, responseBody: {} },
  }, SENDER);

  for (let i = 0; i < 3; i++) await cap('https://x/api/a/' + i);
  await flush();
  let state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 3);

  // PAUSE — conserva el archivo, no trunca.
  await sendMessage(ctx, { type: 'PAUSE' }, SENDER);
  await flush();
  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.isRecording, false, 'PAUSE → isRecording false');
  assert.equal(state.paused, true, 'PAUSE → paused true');
  assert.equal(state.total, 3, 'PAUSE conserva las 3 capturas');

  // Una captura DURANTE pausa debe descartarse.
  await cap('https://x/api/IGNORADA');
  await flush(2);
  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 3, 'una captura durante PAUSE NO cuenta');

  // RESUME — continúa la misma sesión (append), no resetea.
  await sendMessage(ctx, { type: 'RESUME' }, SENDER);
  await flush();
  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.isRecording, true, 'RESUME → isRecording true');
  assert.equal(state.paused, false, 'RESUME → paused false');
  assert.equal(state.total, 3, 'RESUME continúa con las 3 previas (no resetea)');

  for (let i = 0; i < 2; i++) await cap('https://x/api/b/' + i);
  await flush(2);
  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 5, 'tras RESUME + 2 capturas, total = 5 (3+2)');

  await sendMessage(ctx, { type: 'STOP' }, SENDER);
  await flush(2);
  const dl = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER);
  assert.equal(dl.ok, true);
  assert.equal(dl.lineCount, 5, 'el JSONL final debe tener 5 líneas (3 pre-pausa + 2 post-resume)');
});

test('Fase2 — START tras PAUSE SÍ trunca (sesión nueva, no continúa la pausada)', async () => {
  const opfs = makeOpfsMock();
  const ctx = loadBackgroundFresh({ navigator: opfs.navigator });
  await sendMessage(ctx, { type: 'START', tabId: 1 }, SENDER);
  await flush();
  for (let i = 0; i < 3; i++) {
    await sendMessage(ctx, { type: 'CAPTURE', entry: { url: 'https://x/api/old/' + i, method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, responseBody: {} } }, SENDER);
  }
  await flush();
  await sendMessage(ctx, { type: 'PAUSE' }, SENDER);
  await flush();

  // START = sesión nueva → trunca. NO debe arrastrar las 3 viejas.
  await sendMessage(ctx, { type: 'START', tabId: 1 }, SENDER);
  await flush();
  await sendMessage(ctx, { type: 'CAPTURE', entry: { url: 'https://x/api/new/0', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, responseBody: {} } }, SENDER);
  await flush();
  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER);
  assert.equal(state.total, 1, 'START trunca: solo la captura nueva, no las 3 de la sesión pausada');
});
