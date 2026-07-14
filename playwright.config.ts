import { defineConfig } from '@playwright/test';

const previewHost = '127.0.0.1';
const previewPort = 4_173;
const previewUrl = `http://${previewHost}:${String(previewPort)}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: previewUrl,
    browserName: 'chromium',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { height: 900, width: 1_440 },
  },
  webServer: {
    command: `pnpm exec vite preview --host ${previewHost} --port ${String(previewPort)} --strictPort`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: previewUrl,
  },
});
