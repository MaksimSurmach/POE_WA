import { defineConfig } from '@playwright/test';
import light from './playwright.light.config.js';

// Read-only API fixtures: Category Library QA never resets a database.
export default defineConfig({
  ...light,
  testDir: './tests/browser',
  testMatch: 'recipe-category-library.spec.ts',
});
