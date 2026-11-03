import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureRecipe } from '../../../packages/domain/dist/fixtures/recipes.js';
const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(
  await readFile(
    new URL('docs/evidence/craft-profit-2026-11-03/cluster-targets.json', root),
  ),
);
assert.equal(manifest.targets.length, 9);
for (const target of manifest.targets) {
  const recipe = JSON.parse(
    await readFile(new URL(`recipes/cluster-jewel/${target.id}.json`, root)),
  );
  const receipt = JSON.parse(await readFile(new URL(target.artifact, root)));
  assert.deepEqual(fixtureRecipe(recipe), recipe);
  assert.equal(recipe.verification.status, 'verified');
  assert.equal(recipe.base.itemLevel, 68);
  assert.deepEqual(recipe.base, recipe.startingBase);
  assert.deepEqual(recipe.base.variant, {
    kind: 'cluster-jewel',
    passiveCount: 8,
    smallPassiveStatId: target.smallPassiveStatId,
  });
  assert.equal(recipe.base.baseId, target.baseId);
  assert.equal(recipe.target.prefixes.length, 2);
  assert.equal(recipe.target.suffixes.length, 1);
  const authored = [...recipe.target.prefixes, ...recipe.target.suffixes]
    .map((m) => m.modId)
    .sort();
  assert.deepEqual(authored, target.notables.map((m) => m.modId).sort());
  const url = new URL(receipt.calculatorURL);
  const details = JSON.parse(
    Buffer.from(url.searchParams.get('details'), 'base64'),
  );
  const reqs = JSON.parse(Buffer.from(url.searchParams.get('reqs'), 'base64'));
  assert.equal(
    url.searchParams.get('method'),
    {
      'serrated-fossil': '4,21',
      'aberrant-fossil': '4,0',
      'prismatic-fossil': '4,17',
    }[target.fossil],
  );
  assert.deepEqual(details.m, []);
  assert.equal(details.l, 68);
  assert.equal(details.r, 'rare');
  assert.deepEqual(reqs, [
    {
      t: 'and',
      m: null,
      e: receipt.notables.map((m) => ({
        i: m.calculatorId,
        t: null,
        b: true,
        s: null,
      })),
    },
  ]);
  assert.equal(receipt.notables.length, 3);
  assert.equal(recipe.craft.evidence.url, receipt.calculatorURL);
  assert.equal(
    recipe.craft.steps[0].success.probability,
    receipt.displayed.successPercent / 100,
  );
  assert.equal(
    recipe.craft.expectedExecutions[0].count,
    receipt.displayed.expectedAttempts,
  );
  assert.equal(recipe.craft.baseConsumption.expectedBases, 1);
  assert.deepEqual(recipe.craft.steps[0].materials, [
    { itemId: target.fossil, quantity: 1 },
    { itemId: 'primitive-chaotic-resonator', quantity: 1 },
  ]);
  assert.deepEqual(receipt.perFinishedItem.materials, {
    [target.fossil]: target.expectedAttempts,
    'primitive-chaotic-resonator': target.expectedAttempts,
  });
  assert.equal(receipt.ordinaryPaidFailure.scouringRequired, false);
  assert.equal(
    receipt.ordinaryPaidFailure.sameBaseFamilyAndLevelRetained,
    true,
  );
  assert.ok(
    !target.notables.every((n) =>
      receipt.ordinaryPaidFailure.observedNotables.includes(n.name),
    ),
  );
}
console.log(
  'PASS:9 exact cluster definitions, current AND configurations, paid-failure records and complete material/base-consumption bindings.',
);
