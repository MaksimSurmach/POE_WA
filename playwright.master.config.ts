import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  timeout: 60_000,
  globalTimeout: 3 * 60_000,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'output/master-e2e/report', open: 'never' }],
    ['json', { outputFile: 'output/master-e2e/report.json' }],
  ],
  outputDir: 'output/master-e2e/results',
  use: {
    baseURL: process.env.MASTER_E2E_BASE_URL ?? 'http://127.0.0.1:18080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
