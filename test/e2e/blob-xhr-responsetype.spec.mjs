/**
 * blob-xhr-responsetype.spec.mjs — regression for the InvalidStateError crash.
 *
 * Real LinkedIn fires XHRs with responseType='blob' (media + some payloads).
 * The interceptor used to read xhr.responseText unconditionally, which THROWS
 * `InvalidStateError: ... responseType was 'blob'` — and the old catch read it
 * AGAIN outside a try, surfacing as an Uncaught error on the page (the user saw
 * this on linkedin.com/notifications, src/injected.js:245).
 *
 * This test reproduces it headless: it listens for page-level errors while a
 * blob XHR fires under recording, and asserts (a) NO uncaught InvalidStateError
 * and (b) the request is still captured (with a typed placeholder body).
 *
 * Run: npm run test:e2e
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixturesServer } from './fixtures-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(REPO, 'dist', 'unpacked');

async function launch() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'are-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--headless=new',
    ],
  });
  return { ctx };
}

test('blob responseType XHR no crashea la página y se captura igual', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const { ctx } = await launch();

  // Collect page-level uncaught errors — the bug surfaced exactly here.
  const pageErrors = [];

  try {
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
    await page.goto(base + '/');

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    const started = await popup.evaluate(async (urlBase) => {
      const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
      const tabId = tabs[0] && tabs[0].id;
      const captureConfig = {
        preset: 'linkedin-voyager',
        patterns: [{ type: 'literal', value: '/voyager/api/' }],
        filterMode: 'OR',
        redact: { enabled: true, headers: ['csrf-token'], body: ['access_token'] },
      };
      await chrome.runtime.sendMessage({ type: 'START', tabId, captureConfig, outputFormat: 'jsonl' });
      return { tabId };
    }, base);
    expect(started.tabId, 'el popup debe encontrar la tab fixture').toBeTruthy();

    await page.waitForTimeout(1000);

    // Fire the blob XHR (this is what threw before the fix).
    await page.evaluate(() => window.fireBlobXhr());
    await page.waitForTimeout(800);

    // (1) The crash must be gone.
    const invalidState = pageErrors.filter((m) => /InvalidStateError|responseText/i.test(m));
    expect(invalidState, `no debe haber InvalidStateError en la página: ${JSON.stringify(pageErrors)}`).toEqual([]);

    // (2) The request is still captured (honest body placeholder, not a crash).
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok, 'DOWNLOAD no debe responder "No captures"').toBe(true);

    const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const blob = lines.find((l) => l.request && l.request.url && l.request.url.includes('/voyager/api/blob'));
    expect(blob, 'el XHR blob debe quedar capturado pese al responseType binario').toBeTruthy();

    // The body must be DECODED, not skipped — LinkedIn serves Voyager JSON over
    // responseType='blob', and that JSON is exactly what the project needs.
    expect(blob.response.body && blob.response.body.data && blob.response.body.data.rt === true,
      `el body del blob debe venir DECODIFICADO, no skippeado: ${JSON.stringify(blob.response.body)}`).toBe(true);
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
