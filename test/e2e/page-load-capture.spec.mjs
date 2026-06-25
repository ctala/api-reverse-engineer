/**
 * page-load-capture.spec.mjs — proof of the document_start fix (B9).
 *
 * The historical gap: the interceptor was injected only on START (executeScript
 * at-record-time), so calls a SPA fires on page LOAD / navigation (LinkedIn's
 * Voyager graphql) happened BEFORE the interceptor existed and were lost. The
 * user's real captures confirmed it: navigating profiles captured 0 Voyager
 * calls, only post-injection telemetry.
 *
 * The fix installs the interceptor declaratively at document_start (MAIN world)
 * and, after a navigation while recording, the fresh content script re-adopts
 * the recording state (GET_TAB_RECORDING) and the interceptor flushes its
 * load-time buffer through the filter.
 *
 * This test starts recording, navigates the tab to a page that fires a Voyager
 * fetch on parse, and asserts the load-time call is captured — AND its
 * csrf-token is redacted (the buffer is flushed through redaction, not raw).
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

test('document_start captura la llamada de page-load tras navegar grabando (B9)', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const { ctx } = await launch();

  try {
    // Load page 1 to boot the SW + take a stable tabId.
    const page = await ctx.newPage();
    await page.goto(base + '/');

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    // START recording on the fixture tab.
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
    expect(started.tabId).toBeTruthy();

    await page.waitForTimeout(500);

    // NAVIGATE the SAME tab to the page that fires a Voyager fetch on parse.
    // With document_start injection this call must be captured even though it
    // fires before any START reaches the new page.
    await page.goto(base + '/onload-page');
    await page.waitForTimeout(1200);

    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok, 'DOWNLOAD no debe responder "No captures"').toBe(true);

    const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const onload = lines.find((l) => l.request && l.request.url && l.request.url.includes('/voyager/api/onload'));
    expect(onload, 'la llamada de page-load /voyager/api/onload debe estar capturada (document_start)').toBeTruthy();

    // The flush goes THROUGH redaction — the csrf-token must be masked, proving
    // we don't leak the raw buffered entry across the bridge.
    const csrf = onload.request.headers['csrf-token'];
    expect(csrf, 'csrf-token debe venir redactado en la llamada de page-load').toMatch(/REDACTED/i);
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
