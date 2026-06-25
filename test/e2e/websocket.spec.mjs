/**
 * websocket.spec.mjs — WebSocket capture (#20).
 *
 * LinkedIn/Skool realtime chat rides a WebSocket, invisible to fetch/XHR. The
 * interceptor now proxies window.WebSocket. This test connects to a minimal WS
 * endpoint, receives a server push, sends a frame, and asserts BOTH directions
 * are captured (type 'websocket', WS_RECV + WS_SEND).
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
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  });
  return { ctx };
}

test('#20 WebSocket inbound + outbound frames are captured', async () => {
  const fixtures = await startFixturesServer();
  const base = `http://127.0.0.1:${fixtures.port}`;
  const { ctx } = await launch();
  try {
    const page = await ctx.newPage();
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
        preset: 'generic',
        patterns: [{ type: 'literal', value: '/ws' }],
        filterMode: 'OR',
        redact: { enabled: false, headers: [], body: [] },
      };
      await chrome.runtime.sendMessage({ type: 'START', tabId, captureConfig, outputFormat: 'jsonl' });
    }, base);

    await page.waitForTimeout(700);
    await page.evaluate(() => window.fireWebSocket());
    await page.waitForTimeout(900);

    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
    const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
    expect(dl.ok).toBe(true);
    const lines = Buffer.from(dl.data, 'base64').toString('utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const ws = lines.filter((l) => l.request && l.request.url && l.request.url.includes('/ws'));
    expect(ws.length, 'debe haber frames WS capturados').toBeGreaterThan(0);

    const inbound = ws.find((l) => l.request.method === 'WS_RECV');
    expect(inbound, 'frame ENTRANTE capturado').toBeTruthy();
    expect(inbound.response.body && inbound.response.body.event, 'payload del push del servidor').toBe('hello-from-server');

    const outbound = ws.find((l) => l.request.method === 'WS_SEND');
    expect(outbound, 'frame SALIENTE capturado').toBeTruthy();
    expect(outbound.request.body && outbound.request.body.hello, 'payload enviado').toBe('server');
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
