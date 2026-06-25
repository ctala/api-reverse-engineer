/**
 * sw-restart-resume.spec.mjs — Fase 2: durabilidad real (pausa/continuar).
 *
 * Prueba en Chromium REAL lo que el unit no puede simular de verdad: que una
 * grabación sobreviva al teardown del service worker MV3. Forzamos el teardown
 * con CDP (ServiceWorker.stopAllWorkers), lo despertamos con un mensaje, y
 * verificamos que las capturas pre-restart sobreviven (restoreFromExisting
 * re-abre el archivo OPFS y reconstruye el contador desde disco — B4).
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
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'are-restart-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  });
  return ctx;
}

async function pollState(popup, predicate, tries = 30, delay = 200) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    if (predicate(last)) return last;
    await popup.waitForTimeout(delay);
  }
  return last;
}

test('Fase2 — la grabación sobrevive a un restart del service worker', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const ctx = await launch();

  try {
    const page = await ctx.newPage();
    await page.goto(base + '/');
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    // START + capturar requests.
    await popup.evaluate(async (urlBase) => {
      const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
      await chrome.runtime.sendMessage({
        type: 'START',
        tabId: tabs[0] && tabs[0].id,
        captureConfig: { preset: 'generic', patterns: [{ type: 'literal', value: '/voyager/api/' }], filterMode: 'OR', redact: { enabled: false, headers: [], body: [] } },
        outputFormat: 'jsonl',
      });
    }, base);
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.fireRequests());
    await page.waitForTimeout(800);

    let state = await pollState(popup, (s) => s && s.total >= 1);
    const before = state.total;
    expect(before, 'debe haber capturas antes del restart').toBeGreaterThanOrEqual(1);

    // Forzar el teardown del SW (simula el sleep ~30s de MV3).
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');

    // Despertar el SW con un mensaje desde el popup → corre el bloque restore.
    state = await pollState(popup, (s) => s && s.total >= before);
    expect(state.total, 'las capturas pre-restart deben sobrevivir (restoreFromExisting)').toBeGreaterThanOrEqual(before);

    // DOWNLOAD trae las capturas que sobrevivieron.
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok, 'DOWNLOAD no debe abortar tras el restart').toBe(true);
    const lines = Buffer.from(dl.data, 'base64').toString('utf8').trim().split('\n').filter(Boolean);
    expect(lines.length, 'el JSONL debe contener las capturas que sobrevivieron').toBeGreaterThanOrEqual(before);
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
