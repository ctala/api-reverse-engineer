/**
 * fidelity.spec.mjs — the capture must keep YOUR data intact (audit batch).
 *
 * These are the bugs that hurt reverse-engineering even in RAW mode (redaction
 * off): a request body that vanishes, an ID that gets corrupted, a page that
 * hangs. Each is asserted end-to-end through the real extension.
 *
 *   #6  big-int request IDs (entityUrn / snowflake) must survive via bodyRaw
 *   #5  URLSearchParams form bodies must be serialized, not collapsed to {}
 *   #1  a never-ending SSE fetch must NOT hang the page
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

async function startRecording(popup, base) {
  await popup.evaluate(async (urlBase) => {
    const tabs = await chrome.tabs.query({ url: urlBase + '/*' });
    const tabId = tabs[0] && tabs[0].id;
    const captureConfig = {
      preset: 'linkedin-voyager',
      patterns: [{ type: 'literal', value: '/voyager/api/' }],
      filterMode: 'OR',
      // Redaction OFF — this is about data fidelity, not secrets.
      redact: { enabled: false, headers: [], body: [] },
    };
    await chrome.runtime.sendMessage({ type: 'START', tabId, captureConfig, outputFormat: 'jsonl' });
  }, base);
}

async function downloadLines(popup) {
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  const dl = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DOWNLOAD', format: 'jsonl' }));
  expect(dl.ok).toBe(true);
  const jsonl = Buffer.from(dl.data, 'base64').toString('utf8');
  return jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('#6 big-int request ID survives in bodyRaw (parsed copy truncates it)', async () => {
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
    await startRecording(popup, base);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.fireBigIntBody());
    await page.waitForTimeout(800);

    const lines = await downloadLines(popup);
    const write = lines.find((l) => l.request && l.request.url.includes('/voyager/api/write'));
    expect(write, 'el POST /voyager/api/write debe capturarse').toBeTruthy();
    // bodyRaw keeps the exact digits; the parsed copy would read 7123456789012346000.
    expect(write.request.bodyRaw, 'bodyRaw debe preservar el entityUrn exacto (#6)').toContain('7123456789012345678');
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});

test('#5 URLSearchParams form body is serialized, not {}', async () => {
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
    await startRecording(popup, base);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.fireFormBody());
    await page.waitForTimeout(800);

    const lines = await downloadLines(popup);
    const write = lines.find((l) => l.request && l.request.url.includes('/voyager/api/write'));
    expect(write, 'el POST form debe capturarse').toBeTruthy();
    const body = write.request.body;
    expect(typeof body === 'string' && body.includes('user=alice') && body.includes('count=3'),
      `el form body debe serializarse (no {}): ${JSON.stringify(body)}`).toBe(true);
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});

test('#1 SSE fetch resolves immediately and does NOT hang the page', async () => {
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
    await startRecording(popup, base);
    await page.waitForTimeout(800);

    // With the bug, the page's fetch('/sse') never resolves → 'timeout'.
    const outcome = await page.evaluate(() => window.fireSse());
    expect(outcome, 'el fetch a un SSE infinito debe resolver, no colgar la página').toBe('resolved');

    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  } finally {
    await fixtures.close();
    await ctx.close();
  }
});
