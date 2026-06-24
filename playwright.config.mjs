import { defineConfig } from '@playwright/test';

// E2E loads the unpacked extension in a real Chromium. A persistent context is
// required for MV3 extensions, so the suite runs serially (workers: 1).
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
});
