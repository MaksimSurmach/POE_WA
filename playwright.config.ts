import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  globalTimeout: 5 * 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node scripts/browser-server.mjs',
      url: 'http://127.0.0.1:4317/health/ready',
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      env: {
        APP_ENV: 'test',
        APP_PORT: '4317',
        MARKET_COLLECTION_SOURCE: 'disabled',
        POE_TRADE_ACCESS: 'disabled',
        OPERATOR_DIAGNOSTICS_TOKEN: 'browser-fixture-only',
      },
    },
    {
      command:
        'pnpm --filter @poe-worksmith/web exec vite --host 127.0.0.1 --port 4176 --strictPort',
      url: 'http://127.0.0.1:4176',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { WORKSMITH_API_URL: 'http://127.0.0.1:4317' },
    },
  ],
});
