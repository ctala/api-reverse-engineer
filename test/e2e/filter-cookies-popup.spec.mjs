/**
 * filter-cookies-popup.spec.mjs — Fase 3 (preset LinkedIn real + Copy Cookies).
 *
 * Valida en Chromium real:
 *  1. El popup arma el captureConfig desde capture-config.js (fuente única):
 *     patterns reales (voyager/api + rsc-action), exclude de ruido, y B10
 *     (x-restli-protocol-version NO se redacta). Default = generic.
 *  2. El filtro narrowea a endpoints de datos y EXCLUYE telemetría/estáticos,
 *     resolviendo URLs relativas (como la SPA real).
 *  3. Copy Cookies obtiene cookies httpOnly (li_at) vía chrome.cookies — la auth
 *     que fetch no puede leer.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixturesServer } from './fixtures-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(REPO, 'dist', 'unpacked');

async function setup() {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'are-f3-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  return { fixtures, base, ctx, page, popup };
}

test('Fase3 — el popup arma el config desde capture-config (fuente única) + B10 + default generic', async () => {
  const { fixtures, ctx, popup } = await setup();
  try {
    await popup.waitForTimeout(300); // dejar correr loadState (default + dropdown)

    // Dropdown poblado desde PRESETS; default = generic.
    const opts = await popup.evaluate(() =>
      Array.from(document.querySelectorAll('#presetSelect option')).map((o) => o.value));
    expect(opts).toContain('generic');
    expect(opts).toContain('linkedin-voyager');
    expect(await popup.evaluate(() => document.getElementById('presetSelect').value)).toBe('generic');

    // buildCaptureConfig usa el preset canónico de capture-config.js.
    const cfg = await popup.evaluate(() => window.buildCaptureConfig('linkedin-voyager'));
    const vals = cfg.patterns.map((p) => p.value);
    expect(vals).toContain('/voyager/api/');
    expect(vals).toContain('/rsc-action/');
    expect(cfg.exclude.map((p) => p.value)).toContain('trackO11y');
    // B10: x-restli legible; csrf SÍ redactado.
    const heads = cfg.redact.headers.map((h) => h.toLowerCase());
    expect(heads).not.toContain('x-restli-protocol-version');
    expect(heads).toContain('csrf-token');
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});

test('Fase3 — el filtro LinkedIn narrowea a datos y EXCLUYE el ruido (URLs relativas)', async () => {
  const { fixtures, base, ctx, page, popup } = await setup();
  try {
    await popup.waitForTimeout(200);
    await popup.evaluate(async (urlBase) => {
      const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
      const captureConfig = window.buildCaptureConfig('linkedin-voyager');
      await chrome.runtime.sendMessage({ type: 'START', tabId: tabs[0] && tabs[0].id, captureConfig, outputFormat: 'jsonl' });
    }, base);
    await page.waitForTimeout(900);
    await page.evaluate(() => window.fireMixed());
    await page.waitForTimeout(900);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok).toBe(true);
    const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');

    // Datos capturados:
    expect(jsonl, 'voyager/api/me capturado').toContain('/voyager/api/me');
    expect(jsonl, 'rsc-action capturado').toContain('/rsc-action/');
    // Ruido EXCLUIDO:
    expect(jsonl, 'trackO11y NO debe estar').not.toContain('trackO11y');
    expect(jsonl, 'li/track NO debe estar').not.toContain('/li/track');
    expect(jsonl, 'static asset NO debe estar').not.toContain('/static/asset.js');
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});

test('Fase3 — Copy Cookies obtiene cookies httpOnly (li_at) vía chrome.cookies', async () => {
  const { fixtures, base, ctx, popup } = await setup();
  try {
    const res = await popup.evaluate((u) => chrome.runtime.sendMessage({ type: 'GET_COOKIES', url: u + '/' }), base);
    expect(res.ok).toBe(true);
    const names = res.cookies.map((c) => c.name);
    expect(names, 'li_at httpOnly debe aparecer (fetch no puede leerlo)').toContain('li_at');
    const liat = res.cookies.find((c) => c.name === 'li_at');
    expect(liat.httpOnly).toBe(true);
    expect(res.cookieHeader).toContain('li_at=AUTH_TOKEN_SECRET');
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
