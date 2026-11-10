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
  it('loads category directories deterministically and ignores hidden files and obsolete Markdown', async () => {
    const r = await root();
    await write(r, 'b.json', {
      ...canonicalRecipeFixture,
      id: 'b',
      craft: {
        ...canonicalRecipeFixture.craft,
        method: { kind: 'harvest-reforge', tag: 'fire' },
      },
    });
    await write(r, 'a.json', { ...canonicalRecipeFixture, id: 'a' });
    await writeFile(path.join(r, 'recipe.md'), 'obsolete');
    await writeFile(path.join(r, 'cluster-jewel', '._a.json'), 'metadata');
    expect((await loadRecipeCatalog(r)).map((r) => r.definition.id)).toEqual([
      'a',
      'b',
    ]);
  });
  it('ignores recipes under underscore-prefixed directories', async () => {
    const r = await root();
    await mkdir(path.join(r, 'cluster-jewel', '_drafts'));
    await write(r, 'active.json', canonicalRecipeFixture);
    await write(r, '_drafts/draft.json', {
      ...canonicalRecipeFixture,
      id: 'draft',
      craft: {
        ...canonicalRecipeFixture.craft,
        method: { kind: 'harvest-reforge', tag: 'fire' },
      },
    });
    expect(
      (await loadRecipeCatalog(r)).map(({ definition }) => definition.id),
    ).toEqual([canonicalRecipeFixture.id]);
  });
  it.each(['expectedExecutions', 'baseConsumption'] as const)(
    'rejects a verified recipe missing craft.%s',
    async (field) => {
      const r = await root();
      await write(r, 'a.json', {
        ...canonicalRecipeFixture,
        craft: { ...canonicalRecipeFixture.craft, [field]: undefined },
      });
      await expect(loadRecipeCatalog(r)).rejects.toThrow(`craft.${field}`);
    },
  );
  it.each([
    { count: 100, valid: false },
    { count: 1.9, valid: true },
    { count: 2.1, valid: true },
  ])(
    'checks $count executions at probability 0.5',
    async ({ count, valid }) => {
      const r = await root();
      const { craft } = canonicalRecipeFixture;
      const execution = craft.expectedExecutions![0]!;
      await write(r, 'a.json', {
        ...canonicalRecipeFixture,
        craft: {
          ...craft,
          expectedExecutions: [{ ...execution, count }],
          steps: [
            {
              ...craft.steps[0]!,
              success: { evidence: execution.evidence, probability: 0.5 },
            },
          ],
        },
      });
      const catalog = loadRecipeCatalog(r);
      if (valid) await expect(catalog).resolves.toHaveLength(1);
      else await expect(catalog).rejects.toThrow(/within 5% of 2/);
    },
  );
  it('rejects different IDs with the same target signature and method', async () => {
    const r = await root();
    await write(r, 'a.json', canonicalRecipeFixture);
    await write(r, 'b.json', { ...canonicalRecipeFixture, id: 'b' });
    await expect(loadRecipeCatalog(r)).rejects.toThrow(
      /same target signature and craft method/,
    );
  });
  it('rejects duplicate methods with the same fossils in different orders', async () => {
    const r = await root();
    const { craft } = canonicalRecipeFixture;
    const method = {
      kind: 'fossil',
      fossils: ['jagged', 'pristine'],
      resonatorSockets: 2,
    } as const;
    await write(r, 'a.json', {
      ...canonicalRecipeFixture,
      craft: { ...craft, method },
    });
    await write(r, 'b.json', {
      ...canonicalRecipeFixture,
      id: 'b',
      craft: {
        ...craft,
        method: { ...method, fossils: ['pristine', 'jagged'] },
      },
    });
    await expect(loadRecipeCatalog(r)).rejects.toThrow(
      /same target signature and craft method/,
    );
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
