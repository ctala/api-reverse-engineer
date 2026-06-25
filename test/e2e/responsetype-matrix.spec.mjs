/**
 * responsetype-matrix.spec.mjs — exhaust the XHR responseType enum.
 *
 * The blob-responseType crash + body-loss happened because the interceptor only
 * handled the responseType values we *imagined* (''/text/json). The enum is
 * finite: '', 'text', 'json', 'blob', 'arraybuffer', 'document'. This test
 * fires the SAME JSON endpoint with EVERY value and asserts, by construction:
 *
 *   (1) ZERO page-level uncaught errors across all of them (the interceptor
 *       must never throw into the page — it wraps the page's own XHR).
 *   (2) the readable ones ('', text, json, blob, arraybuffer) are DECODED to
 *       the JSON body (data.rt === true), not skipped.
 *
 * 'document' can't parse a JSON payload, so it's allowed to degrade to a typed
 * placeholder — but it must still NOT crash.
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

test('responseType matrix — ningún valor crashea y los legibles se decodifican', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const { ctx } = await launch();
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

    await popup.evaluate(async (urlBase) => {
      const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
      const tabId = tabs[0] && tabs[0].id;
      const captureConfig = {
        preset: 'linkedin-voyager',
        patterns: [{ type: 'literal', value: '/voyager/api/' }],
        filterMode: 'OR',
        redact: { enabled: true, headers: ['csrf-token'], body: ['access_token'] },
      };
      await chrome.runtime.sendMessage({ type: 'START', tabId, captureConfig, outputFormat: 'jsonl' });
    }, base);

    await page.waitForTimeout(800);
    await page.evaluate(() => window.fireResponseTypeMatrix());
    await page.waitForTimeout(1000);

    // (1) No uncaught errors for ANY responseType.
    expect(pageErrors, `el interceptor no debe tirar excepción para ningún responseType: ${JSON.stringify(pageErrors)}`).toEqual([]);

    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok).toBe(true);

    const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byRt = (rt) => lines.find((l) => l.request && l.request.url && l.request.url.includes('rt=' + rt));

    // (2) The readable responseTypes must be DECODED to the JSON body.
    for (const rt of ['default', 'text', 'json', 'blob', 'arraybuffer']) {
      const entry = byRt(rt);
      expect(entry, `responseType '${rt}' debe estar capturado`).toBeTruthy();
      const body = entry.response.body;
      expect(body && body.data && body.data.rt === true,
        `responseType '${rt}' debe decodificar el JSON, no skippearlo: ${JSON.stringify(body)}`).toBe(true);
    }

    // 'document' must be captured without crashing (body may be a placeholder).
    expect(byRt('document'), `responseType 'document' debe estar capturado (sin crash)`).toBeTruthy();
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
