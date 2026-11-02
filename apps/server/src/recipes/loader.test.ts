import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalRecipeFixture } from '@poe-worksmith/domain/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRecipeCatalog } from './loader.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { force: true, recursive: true })),
  );
});
async function root() {
  const r = await mkdtemp(path.join(tmpdir(), 'recipe-catalog-'));
  roots.push(r);
  await mkdir(path.join(r, 'cluster-jewel'));
  return r;
}
async function write(r: string, name: string, value: unknown) {
  await writeFile(path.join(r, 'cluster-jewel', name), JSON.stringify(value));
}
describe('canonical Git JSON recipe loader', () => {
  it('loads category directories deterministically and ignores obsolete Markdown', async () => {
    const r = await root();
    await write(r, 'b.json', { ...canonicalRecipeFixture, id: 'b' });
    await write(r, 'a.json', { ...canonicalRecipeFixture, id: 'a' });
    await writeFile(path.join(r, 'recipe.md'), 'obsolete');
    expect((await loadRecipeCatalog(r)).map((r) => r.definition.id)).toEqual([
      'a',
      'b',
    ]);
  });
  it('rejects duplicate IDs and reports schema errors without partial catalog', async () => {
    const r = await root();
    await write(r, 'a.json', canonicalRecipeFixture);
    await write(r, 'b.json', canonicalRecipeFixture);
    await expect(loadRecipeCatalog(r)).rejects.toThrow(/Duplicate recipe id/);
    await write(r, 'b.json', { schemaVersion: 2 });
    await expect(loadRecipeCatalog(r)).rejects.toThrow(/schemaVersion/);
  });
  it('rejects a changed output with an old signature', async () => {
    const r = await root();
    await write(r, 'a.json', {
      ...canonicalRecipeFixture,
      base: { ...canonicalRecipeFixture.base, rarity: 'magic' },
    });
    await expect(loadRecipeCatalog(r)).rejects.toThrow(/signature/);
  });
});
