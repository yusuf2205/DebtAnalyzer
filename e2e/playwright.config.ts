import { defineConfig } from '@playwright/test';

// Локально без загрузки браузера: E2E_CHANNEL=msedge (установленный Edge) или chrome. В CI — npx playwright install chromium и без переменной.
export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,            // сценарии идут последовательно: каждый опирается на данные предыдущего
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://localhost:3100',
    channel: process.env.E2E_CHANNEL || undefined,
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  webServer: { command: 'node stack.mjs', cwd: __dirname, url: 'http://localhost:3100/login', timeout: 240_000, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
});
