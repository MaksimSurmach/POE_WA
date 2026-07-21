import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const fixtureDirectory = new URL('./fixtures/poeTrade/', import.meta.url);
const forbiddenKeys =
  /^(cookie|authorization|set-cookie|email|ip|access_token|refresh_token)$/i;
const forbiddenStrings = [
  'www.pathofexile.com',
  'contact:',
  'test@example.com',
];

describe('PoE Trade fixtures', () => {
  it('contain only sanitized fixture data', async () => {
    const files = await readdir(fixtureDirectory);
    for (const file of files) {
      const source = await readFile(new URL(file, fixtureDirectory), 'utf8');
      const value = JSON.parse(source) as unknown;
      expect(source).not.toContain('www.pathofexile.com');
      for (const forbidden of forbiddenStrings)
        expect(source).not.toContain(forbidden);
      assertSafeFixture(value);
    }
  });
});

function assertSafeFixture(value: unknown): void {
  if (Array.isArray(value)) return void value.forEach(assertSafeFixture);
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    expect(key).not.toMatch(forbiddenKeys);
    if (key === 'name') expect(nested).toMatch(/^fixture-(seller|item)-\d+$/);
    assertSafeFixture(nested);
  }
}
