import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/preview',
  workers: 1,
  reporter: 'list',
  outputDir: 'output/playwright/test-results/preview',
  use: { screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 900 } } },
  ],
});
