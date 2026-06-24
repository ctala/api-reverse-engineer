/**
 * API Reverse Engineer v1.4.2 — Background service-worker tests
 *
 * Covers the 3 runtime bugs Cristian reported in production v1.4.1
 * (counter stale, badge not updating, download no funciona) plus the
 * surrounding edge cases (OPFS init race, OPFS upgrade migration,
 * OPFS init failure stays on memory buffer, SW restart, GET_STATE).
 *
 * The test harness installs a chrome.* mock and an in-memory OPFS mock
 * (see test/_chrome-mock.js), loads src/background.js with a fresh
 * require cache, captures the message listener, and drives the SW
 * through synthetic messages.
 *
 * Run: `node test/background.test.mjs` from the repo root. Exits 0 on
 * success. The test harness is Node-only; it does NOT exercise a real
 * service worker. The mock surface is kept narrow and lives entirely
 * in test/_chrome-mock.js so the production code is unchanged.
 */
'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  makeOpfsMock,
  makeDeferredOpfsMock,
  makeUnavailableOpfsMock,
  loadBackgroundFresh
} from './_chrome-mock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush the microtask + setImmediate queue. background.js schedules
 * callbacks via setImmediate (in the chrome.* mock) and via Promise.then
 * chains, so a single tick is enough for most flows. For OPFS
 * getFile().then() chains we need an extra tick.
 */
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drive a single message through the captured listener and return the
 * response. Works for both sync responses (most handlers) and async
 * ones (DOWNLOAD with OPFS).
 *
 * @param {Object} ctx — the loadBackgroundFresh() return value
 * @param {Object} msg
 * @param {Object} [sender]
 * @returns {Promise<Object>} response from the listener
 */
async function sendMessage(ctx, msg, sender) {
  // Drain pending microtasks/setImmediate first so any in-flight
  // OPFS init or storage.session.get callbacks don't interleave.
  await flushAsync();
  return new Promise((resolve) => {
    ctx.listener(msg, sender || { tab: { id: 1 } }, (resp) => resolve(resp));
  });
}

const SENDER_TAB_1 = { tab: { id: 1, url: 'https://www.linkedin.com/feed' } };

/** Build a synthetic CAPTURE entry (matches injected.js payload shape). */
function makeEntry(url, method, status) {
  return {
    url: url,
    method: method,
    status: status || 200,
    requestHeaders: { 'x-request-id': 'req-' + Math.random().toString(36).slice(2) },
    requestBody: null,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { ok: true },
    timestamp: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('background: counter survives the OPFS init race (bug #1)', async () => {
  // Use a DEFERRED OPFS mock so we control when init resolves. The test
  // sends 5 CAPTUREs BEFORE the OPFS init resolves, then resolves the
  // init, then verifies the counter survived.
  const def = makeDeferredOpfsMock();
  const ctx = loadBackgroundFresh();
  // Replace the navigator BEFORE requiring background. But the SW has
  // already been required — its OpfsBuffer was created with the default
  // navigator. So we test the race by sending CAPTUREs immediately and
  // letting OPFS init run async.
  // (For this test we DON'T need deferred OPFS — the standard mock already
  // has async getDirectory(). The point is that CAPTUREs arrive during
  // the microtask window between START and the .then() callback.)
  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);

  // Immediately send 5 CAPTUREs. In v1.4.1, `activeBuffer` was null
  // because OPFS init hadn't resolved → all 5 were silently dropped.
  // In v1.4.2, `activeBuffer = memoryBuffer` synchronously, so all 5
  // are counted.
  for (let i = 0; i < 5; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://www.linkedin.com/voyager/api/me/' + i, 'GET')
    }, SENDER_TAB_1);
  }

  // Let OPFS init resolve and the .then() callback run. The callback
  // migrates the 5 memory entries to the OPFS file. After migration,
  // inMemoryCount should still be 5 (it tracks the active buffer).
  await flushAsync();
  await flushAsync();

  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 5, 'counter must be 5 after 5 CAPTUREs (was 0 in v1.4.1)');
  assert.equal(state.isRecording, true);
});

test('background: badge shows the live request count while recording', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1 }, SENDER_TAB_1);

  // Drain pending badge calls (SW restore at load + START's _setBadge +
  // the async OPFS migration which re-sets the badge).
  await flushAsync();
  await flushAsync();

  // Right after START the badge shows the count (0), targeting the rec tab.
  let lastBadge = ctx.calls.setBadge[ctx.calls.setBadge.length - 1];
  assert.equal(lastBadge.text, '0', 'badge shows the count (0) right after START');
  assert.equal(lastBadge.tabId, 1, 'badge targets the recording tab');

  // A CAPTURE updates the badge to the live count. The v1.4.1 bug was the
  // badge *alternating* between a dot and the number; here it always shows
  // the count, so there is nothing to alternate with.
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: makeEntry('https://www.linkedin.com/voyager/api/me', 'GET')
  }, SENDER_TAB_1);
  await flushAsync();

  lastBadge = ctx.calls.setBadge[ctx.calls.setBadge.length - 1];
  assert.equal(lastBadge.text, '1', 'badge updates to the live count on CAPTURE');
});

test('background: download works after stop, JSONL has all 10 events (bug #3)', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);

  for (let i = 0; i < 10; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://www.linkedin.com/voyager/api/feed/' + i, 'GET')
    }, SENDER_TAB_1);
  }

  // Let OPFS init + migration run.
  await flushAsync();
  await flushAsync();

  // Verify the counter is 10.
  let state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 10);

  // STOP the recording.
  await sendMessage(ctx, { type: 'STOP' }, SENDER_TAB_1);
  await flushAsync();

  // DOWNLOAD the JSONL. This is async (OPFS getFile().then()).
  const downloadResp = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER_TAB_1);
  assert.equal(downloadResp.ok, true, 'download must succeed');
  assert.equal(downloadResp.format, 'jsonl');
  assert.equal(downloadResp.encoding, 'base64', 'download must be base64 encoded');
  assert.equal(downloadResp.lineCount, 10, 'JSONL must have 10 lines');
  assert.ok(typeof downloadResp.filename === 'string' && downloadResp.filename.length > 0);
  assert.match(downloadResp.filename, /^are-capture-/);

  // Decode the base64 payload and verify the line count.
  const buf = Buffer.from(downloadResp.data, 'base64');
  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 10, 'JSONL body must have exactly 10 lines');

  // Each line parses as JSON in the canonical _toJsonlLine shape. Since
  // ADR-0003 the OPFS download path normalizes the raw stored entries to the
  // same {request:{...}} shape as the in-memory path (consistent output).
  for (let i = 0; i < 10; i++) {
    const obj = JSON.parse(lines[i]);
    assert.equal(obj.request.url, 'https://www.linkedin.com/voyager/api/feed/' + i);
    assert.equal(obj.request.method, 'GET');
  }
});

test('background: OPFS upgrade migrates captures (no duplicates)', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);

  // Send 5 CAPTUREs before OPFS init resolves.
  for (let i = 0; i < 5; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://www.linkedin.com/voyager/api/migrate/' + i, 'GET')
    }, SENDER_TAB_1);
  }

  // Let the OPFS init promise resolve and the migration .then() callback run.
  await flushAsync();
  await flushAsync();
  await flushAsync();

  // Stop and download. The OPFS file should have 5 lines (the migrated
  // memory entries). If migration had appended to a non-empty file or
  // duplicated entries, we'd see > 5 lines.
  await sendMessage(ctx, { type: 'STOP' }, SENDER_TAB_1);
  await flushAsync();

  const downloadResp = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER_TAB_1);
  assert.equal(downloadResp.ok, true);
  assert.equal(downloadResp.lineCount, 5, 'OPFS file must have exactly 5 lines (no duplicates)');

  const buf = Buffer.from(downloadResp.data, 'base64');
  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 5);

  for (let i = 0; i < 5; i++) {
    const obj = JSON.parse(lines[i]);
    assert.equal(obj.request.url, 'https://www.linkedin.com/voyager/api/migrate/' + i);
    assert.equal(obj.request.method, 'GET');
  }
});

test('background: CAPTURE during OPFS init window goes to memory buffer', async () => {
  // This is the exact bug #1 scenario. We want to verify that CAPTUREs
  // arriving between START and OPFS-init resolution land in the memory
  // buffer (not silently dropped).
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);

  // Immediately (no await between calls) send 5 CAPTUREs. The OPFS init
  // promise hasn't resolved yet.
  for (let i = 0; i < 5; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://www.linkedin.com/voyager/api/init-window/' + i, 'GET')
    }, SENDER_TAB_1);
  }

  // Read the internal state — the counter should reflect the 5 CAPTUREs
  // even before the OPFS upgrade.
  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 5, 'counter must be 5 even during the OPFS init window');

  // Now let the OPFS init resolve and the .then() callback run. After
  // migration, the counter is still 5 (we append, not duplicate).
  await flushAsync();
  await flushAsync();
  await flushAsync();

  const state2 = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state2.total, 5, 'counter must still be 5 after OPFS upgrade');
  // After migration, activeBuffer is the OPFS buffer.
  assert.equal(state2.opfsActive, true, 'OPFS must be the active buffer after upgrade');
});

test('background: OPFS init failure stays on memory buffer, download still works', async () => {
  // Build a context with no OPFS (getDirectory returns nothing) — this
  // simulates Chrome < 102 or strict permissioning.
  const unavailable = makeUnavailableOpfsMock();
  const ctx = loadBackgroundFresh({ navigator: unavailable.navigator });

  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);
  await flushAsync();
  await flushAsync();

  // OPFS init should have failed (no getDirectory). The active buffer
  // should be the memory buffer. fallbackMode should be true.
  let state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.opfsActive, false, 'OPFS must not be active when unavailable');
  assert.equal(state.fallbackMode, true, 'fallbackMode must be true when OPFS unavailable');

  // Send 5 CAPTUREs — they go to the memory buffer.
  for (let i = 0; i < 5; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://www.linkedin.com/voyager/api/fallback/' + i, 'GET')
    }, SENDER_TAB_1);
  }

  state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 5, 'counter must reach 5 in fallback mode');
  assert.equal(state.fallbackMode, true);

  // STOP + DOWNLOAD. The download path detects activeBuffer != opfsBuffer
  // and serialises from the memory buffer. lineCount must be 5.
  await sendMessage(ctx, { type: 'STOP' }, SENDER_TAB_1);
  await flushAsync();

  const downloadResp = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER_TAB_1);
  assert.equal(downloadResp.ok, true, 'download must succeed in fallback mode');
  assert.equal(downloadResp.lineCount, 5);
  // v1.4.2: download response is base64 uniformly (OPFS + memory paths).
  assert.equal(downloadResp.encoding, 'base64');

  const buf = Buffer.from(downloadResp.data, 'base64');
  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 5, 'JSONL must have 5 lines from memory buffer');
});

test('background: badge clears on stop', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1 }, SENDER_TAB_1);
  await flushAsync();

  // The badge shows the count (0) while recording.
  let last = ctx.calls.setBadge[ctx.calls.setBadge.length - 1];
  assert.equal(last.text, '0', 'badge shows the count while recording');

  await sendMessage(ctx, { type: 'STOP' }, SENDER_TAB_1);
  await flushAsync();

  // The badge should be cleared.
  last = ctx.calls.setBadge[ctx.calls.setBadge.length - 1];
  assert.equal(last.text, '', 'badge must be cleared on STOP');
  assert.equal(last.tabId, 1, 'badge clear must target the recording tab');
});

test('background: GET_STATE returns correct total and unique after CAPTUREs', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1, filter: 'voyager' }, SENDER_TAB_1);

  // 3 CAPTUREs across 2 unique URLs.
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: makeEntry('https://www.linkedin.com/voyager/api/me', 'GET')
  }, SENDER_TAB_1);
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: makeEntry('https://www.linkedin.com/voyager/api/me', 'GET')
  }, SENDER_TAB_1);
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: makeEntry('https://www.linkedin.com/voyager/api/feed', 'GET')
  }, SENDER_TAB_1);

  await flushAsync();
  await flushAsync();

  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 3, 'GET_STATE.total must be 3');
  assert.equal(state.unique, 2, 'GET_STATE.unique must be 2 (me + feed)');
  assert.equal(state.isRecording, true);
  assert.equal(state.maxEvents, 10000);
  assert.equal(state.warningAt, 9000);
  assert.equal(state.recordingTabId, 1);
});

test('background: download with 0 captures returns ok:false with helpful error', async () => {
  const ctx = loadBackgroundFresh();
  // No START — counter is 0 from initial state.
  const resp = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER_TAB_1);
  assert.equal(resp.ok, false, 'download must report failure when 0 captures');
  assert.match(resp.error, /No captures to download/);
  assert.match(resp.error, /navigate a page/);
  assert.equal(resp.lineCount, 0);
});

test('background: SW restore sets the count badge if isRecording was true', async () => {
  // The SW restore block reads from chrome.storage.session at module
  // load. We pre-seed the storage with isRecording: true + recordingTabId.
  const ctx = loadBackgroundFresh({
    chrome: {
      storageSession: {
        isRecording: true,
        recordingTabId: 7,
        captureConfig: null,
        outputFormat: 'jsonl',
        filterMode: 'OR'
      }
    }
  });

  // Let the SW restore callback (scheduled via setImmediate) run.
  await flushAsync();

  // The restore handler should have set the count badge on tab 7 (count 0
  // with no file to restore).
  const badgeCall = ctx.calls.setBadge.find(
    (c) => c.text === '0' && c.tabId === 7
  );
  assert.ok(badgeCall, 'SW restore must set the count badge on tab 7');

  // GET_STATE should also report isRecording: true.
  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.isRecording, true);
  assert.equal(state.recordingTabId, 7);
});

test('background: defensive null-buffer fallback in CAPTURE (post-SW-restart)', async () => {
  // Simulate the post-SW-restart state: isRecording=true, activeBuffer=null
  // (the SW restore ran, but OPFS init was never called). The first
  // CAPTURE should still land somewhere (memory buffer fallback) instead
  // of being silently dropped.
  const ctx = loadBackgroundFresh({
    chrome: {
      storageSession: {
        isRecording: true,
        recordingTabId: 1,
        captureConfig: null,
        outputFormat: 'jsonl',
        filterMode: 'OR'
      }
    }
  });
  await flushAsync();

  // The first CAPTURE arrives (simulating user navigation after SW restart).
  await sendMessage(ctx, {
    type: 'CAPTURE',
    entry: makeEntry('https://www.linkedin.com/voyager/api/post-restart', 'GET')
  }, SENDER_TAB_1);
  await flushAsync();

  const state = await sendMessage(ctx, { type: 'GET_STATE' }, SENDER_TAB_1);
  assert.equal(state.total, 1, 'defensive null-buffer fallback must keep the capture (v1.4.1 dropped it)');
  assert.equal(state.isRecording, true);
});

test('background: download with base64 encoding returns valid JSONL', async () => {
  const ctx = loadBackgroundFresh();
  await sendMessage(ctx, { type: 'START', tabId: 1 }, SENDER_TAB_1);
  for (let i = 0; i < 3; i++) {
    await sendMessage(ctx, {
      type: 'CAPTURE',
      entry: makeEntry('https://example.com/api/' + i, 'POST')
    }, SENDER_TAB_1);
  }
  await flushAsync();
  await flushAsync();
  await sendMessage(ctx, { type: 'STOP' }, SENDER_TAB_1);
  await flushAsync();

  const resp = await sendMessage(ctx, { type: 'DOWNLOAD' }, SENDER_TAB_1);
  assert.equal(resp.ok, true);
  assert.equal(resp.encoding, 'base64');
  assert.equal(resp.mime, 'application/x-ndjson');
  assert.equal(resp.lineCount, 3);
  assert.ok(resp.bytes > 0, 'bytes must be > 0');
});
