import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/light',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'output/playwright/light-results',
  use: { baseURL: 'http://127.0.0.1:5188', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command:
      'pnpm --filter @poe-worksmith/web exec vite --host 127.0.0.1 --port 5188 --strictPort',
    url: 'http://127.0.0.1:5188',
    reuseExistingServer: false,
  },
});
