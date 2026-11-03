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
const mappingManifest = JSON.parse(
  await readFile(
    new URL(
      'apps/server/mappings/poe-trade/3.29.3.3/recipe-catalog.json',
      root,
    ),
  ),
);
const replay = JSON.parse(
  await readFile(
    new URL(
      'docs/evidence/craft-profit-2026-11-03/cluster-replay-validation.json',
      root,
    ),
  ),
);
const families = {
  'base:large-cluster-bow': ['150', '2476.3', 'affliction_bow_damage'],
  'base:large-cluster-cold': ['161', '2476.14', 'affliction_cold_damage'],
  'base:large-cluster-shield-attack': [
    '154',
    '2476.7',
    'affliction_attack_damage_while_holding_a_shield',
  ],
  'base:large-cluster-chaos': ['162', '2476.15', 'affliction_chaos_damage'],
  'base:large-cluster-two-handed': [
    '152',
    '2476.5',
    'affliction_damage_with_two_handed_melee_weapons',
  ],
  'base:large-cluster-fire': ['159', '2476.12', 'affliction_fire_damage'],
};
const chaosBaselines = JSON.parse(
  await readFile(
    new URL(
      'docs/evidence/craft-profit-2026-11-03/cluster-chaos-baselines.json',
      root,
    ),
  ),
);
let chaosCount = 0;

for (const target of manifest.targets) {
  const recipe = JSON.parse(
    await readFile(new URL(`recipes/cluster-jewel/${target.id}.json`, root)),
  );
  const receipt = JSON.parse(await readFile(new URL(target.artifact, root)));
  const isChaos = target.method?.kind === 'currency';
  const method = isChaos
    ? { kind: 'currency', currency: 'chaos-orb' }
    : { kind: 'fossil', fossils: [target.fossil], resonatorSockets: 1 };
  const materials = isChaos
    ? [{ itemId: 'chaos-orb', quantity: 1 }]
    : [
        { itemId: target.fossil, quantity: 1 },
        { itemId: 'primitive-chaotic-resonator', quantity: 1 },
      ];
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
    isChaos
      ? '0,5,0'
      : {
          'serrated-fossil': '4,21',
          'aberrant-fossil': '4,0',
          'prismatic-fossil': '4,17',
        }[target.fossil],
  );
  assert.deepEqual(details.m, []);
  assert.equal(details.l, 68);
  assert.equal(details.r, 'rare');
  const [classId, itemId, affliction] = families[target.baseId];
  assert.equal(url.searchParams.get('class'), classId);
  assert.equal(url.searchParams.get('item'), itemId);
  assert.equal(url.searchParams.get('ilvl'), '68');
  assert.equal(details.at, affliction);
  assert.deepEqual(recipe.craft.method, method);
  const mapping = mappingManifest.mappings.find(
    (m) => m.entityKind === 'base' && m.canonicalId === target.baseId,
  );
  assert.equal(mapping?.payload?.filters?.['enchant.stat_3086156145'], 8);
  assert.equal(mapping?.payload?.filters?.['enchant.stat_4079888060'], 2);
  for (const notable of receipt.notables) {
    const bucket =
      notable.origin === 'prefix'
        ? recipe.target.prefixes
        : recipe.target.suffixes;
    assert.ok(bucket.some((mod) => mod.modId === notable.modId));
  }
  for (const evidenceURL of [
    recipe.craft.evidence.url,
    recipe.craft.steps[0].success.evidence.url,
    recipe.craft.expectedExecutions[0].evidence.url,
    recipe.craft.baseConsumption.evidence.url,
    recipe.verification.sources[0],
  ]) {
    assert.equal(evidenceURL, receipt.calculatorURL);
  }
  const historicalArtifact = target.comparison?.artifact ?? target.artifact;
  const historicalReceipt = JSON.parse(
    await readFile(new URL(historicalArtifact, root)),
  );
  const actualReplay = replay.rows.find((r) => r.recipeId === target.id);
  assert.ok(actualReplay?.matched);
  assert.equal(actualReplay.calculatorURL, historicalReceipt.calculatorURL);
  assert.equal(
    actualReplay.successPercent,
    historicalReceipt.displayed.successPercent,
  );
  assert.equal(
    actualReplay.expectedAttempts,
    historicalReceipt.displayed.expectedAttempts,
  );
  if (isChaos) {
    chaosCount++;
    const observed = chaosBaselines.models.find(
      (m) => m.recipeId === target.id,
    );
    assert.ok(observed);
    assert.equal(receipt.calculatorURL, observed.calculatorURL);
    assert.equal(
      receipt.displayed.successPercent,
      observed.displayed.successPercent,
    );
    assert.equal(
      receipt.displayed.expectedAttempts,
      observed.displayed.expectedChaosUses,
    );
    assert.deepEqual(receipt.ordinaryPaidFailure, observed.ordinaryPaidFailure);
    assert.deepEqual(observed.ordinaryPaidFailure.materialsConsumed, {
      'chaos-orb': 1,
    });
    const priorURL = new URL(historicalReceipt.calculatorURL);
    for (const field of ['reqs', 'details', 'class', 'item', 'ilvl']) {
      assert.equal(
        url.searchParams.get(field),
        priorURL.searchParams.get(field),
      );
    }
    assert.equal(target.comparison.fossil, 'serrated-fossil');
    assert.equal(target.comparison.bulkCost, 'unconfirmed');
    assert.equal(
      target.comparison.expectedAttempts,
      historicalReceipt.displayed.expectedAttempts,
    );
    assert.equal(
      target.comparison.probability,
      historicalReceipt.displayed.successPercent / 100,
    );
  }

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
    Number(recipe.craft.steps[0].success.probability.toFixed(12)),
    Number((receipt.displayed.successPercent / 100).toFixed(12)),
  );
  assert.equal(
    recipe.craft.expectedExecutions[0].count,
    receipt.displayed.expectedAttempts,
  );
  assert.equal(recipe.craft.baseConsumption.expectedBases, 1);
  assert.deepEqual(recipe.craft.steps[0].materials, materials);
  assert.equal(
    recipe.craft.expectedExecutions[0].stepId,
    recipe.craft.steps[0].id,
  );
  assert.equal(
    Number(target.probability.toFixed(12)),
    Number((receipt.displayed.successPercent / 100).toFixed(12)),
  );
  assert.equal(target.expectedAttempts, receipt.displayed.expectedAttempts);
  assert.deepEqual(
    receipt.perFinishedItem.materials,
    isChaos
      ? { 'chaos-orb': target.expectedAttempts }
      : {
          [target.fossil]: target.expectedAttempts,
          'primitive-chaotic-resonator': target.expectedAttempts,
        },
  );
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
assert.equal(chaosCount, 5);
console.log(
  'PASS:9 exact cluster definitions, current AND configurations, paid-failure records and complete material/base-consumption bindings.',
);
