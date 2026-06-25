/**
 * record-download.spec.mjs — the browser-level proof.
 *
 * Loads the unpacked extension in a real Chromium (--headless=new), drives a
 * full capture through the REAL extension contexts (popup → service worker →
 * content script → injected MAIN-world interceptor → OPFS), and asserts the
 * downloaded JSONL. This is the layer the node unit suite structurally cannot
 * reach (real MV3 messaging, real injection, real OPFS), where most of the
 * historical fix(...) bugs lived.
 *
 * Run: npm run test:e2e   (pretest:e2e builds dist/unpacked first)
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
  // channel:'chromium' + --headless=new is the combination that actually loads
  // MV3 extensions + starts the service worker in headless (the plain bundled
  // build does not). See microsoft/playwright#33928.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--headless=new',
    ],
  });
  return { ctx, userDataDir };
}

test('B1+B2 — la extensión real captura fetch+XHR y el JSONL descargado los contiene', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const { ctx } = await launch();

  try {
    // Abrir la página fixture PRIMERO — el SW MV3 arranca lazy, recién con la
    // primera página (content.js se inyecta declarativamente en document_start).
    const page = await ctx.newPage();
    await page.goto(base + '/');

    // Ahora sí, el SW está vivo.
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    // B1: los buffers deben existir en el SW REAL (no pre-inyectados por un mock).
    const buffersOk = await sw.evaluate(() => !!self.OpfsBuffer && !!self.MemoryBuffer);
    expect(buffersOk, 'OpfsBuffer/MemoryBuffer deben cargar vía importScripts en el SW real').toBe(true);

    // Popup: contexto de extensión con chrome.runtime + chrome.tabs.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    // START sobre la tab fixture, vía popup → SW (mensajería MV3 real).
    const started = await popup.evaluate(async (urlBase) => {
      const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
      const tabId = tabs[0] && tabs[0].id;
      const captureConfig = {
        preset: 'linkedin-voyager',
        patterns: [{ type: 'literal', value: '/voyager/api/' }],
        filterMode: 'OR',
        redact: { enabled: true, headers: ['csrf-token'], body: ['access_token'] },
      };
      const res = await chrome.runtime.sendMessage({ type: 'START', tabId, captureConfig, outputFormat: 'jsonl' });
      return { tabId, res };
    }, base);
    expect(started.tabId, 'el popup debe encontrar la tab fixture').toBeTruthy();

    // Dar tiempo a la inyección del interceptor + registro del PING del content script.
    await page.waitForTimeout(1000);

    // Disparar los requests DESPUÉS de START (inyección actual = al-grabar).
    await page.evaluate(() => window.fireRequests());
    await page.waitForTimeout(1000);

    // STOP + DOWNLOAD vía popup → SW.
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok, 'DOWNLOAD no debe responder "No captures"').toBe(true);

    const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
    const lines = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const me = lines.find((l) => l.request && l.request.url && l.request.url.includes('/voyager/api/me'));
    expect(me, 'el endpoint /voyager/api/me debe estar capturado (B1 cableado + B2 filtro)').toBeTruthy();
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
