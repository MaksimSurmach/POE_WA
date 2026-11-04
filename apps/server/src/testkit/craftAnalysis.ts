import { randomUUID } from 'node:crypto';
import {
  craftModelSaveInputSchema,
  craftModelRecordSchema,
} from '@poe-worksmith/contracts';
import { canonicalRecipeFixture } from '@poe-worksmith/domain/fixtures';

export const craftFixtureAt = '2026-11-04T12:00:00.000Z';
export const craftFixtureProvenance = {
  kind: 'assumption' as const,
  reference: 'synthetic:craft-analysis-regression',
  recordedAt: craftFixtureAt,
  notes:
    'Labelled synthetic numerical scenario; not game or market observations',
};
export function craftAnalysisFixture() {
  const p = craftFixtureProvenance;
  return craftModelSaveInputSchema.parse({
    recipeId: canonicalRecipeFixture.id,
    recipeHash: 'fixture-recipe-revision',
    league: 'Fixture League',
    expectedRevision: null,
    idempotencyKey: randomUUID(),
    currency: 'chaos',
    model: {
      version: 1,
      id: 'synthetic-target-and-salvage',
      startStageId: 'roll',
      stages: [
        {
          id: 'roll',
          name: 'Synthetic attempt',
          costs: [
            { kind: 'base', resourceId: 'base', quantity: '1', provenance: p },
            {
              kind: 'material',
              resourceId: 'material',
              quantity: '1',
              provenance: p,
            },
          ],
          exclusivity: { mode: 'disjoint', provenance: p },
          outcomes: [
            {
              id: 'target',
              name: 'Target',
              classification: 'target',
              probability: { value: '0.5', provenance: p },
              nextStageId: null,
              targetSuccess: true,
              sellable: true,
              matching: {
                kind: 'exact-target',
                targetSignature: canonicalRecipeFixture.targetSignature,
              },
            },
            {
              id: 'salvage',
              name: 'Salvage',
              classification: 'salvage',
              probability: { value: '0.5', provenance: p },
              nextStageId: null,
              targetSuccess: false,
              sellable: true,
              matching: {
                kind: 'manual',
                description: 'Confirmed synthetic salvage category',
              },
            },
          ],
        },
      ],
    },
    prices: {
      base: { amount: '1', currency: 'chaos', provenance: p },
      material: { amount: '1', currency: 'chaos', provenance: p },
    },
    valuations: {
      target: {
        min: '10',
        max: '10',
        currency: 'chaos',
        matching: {
          kind: 'exact-target',
          targetSignature: canonicalRecipeFixture.targetSignature,
        },
        provenance: p,
      },
      salvage: {
        min: '2',
        max: '2',
        currency: 'chaos',
        matching: {
          kind: 'manual',
          description: 'Confirmed synthetic salvage category',
        },
        provenance: p,
      },
    },
  });
}
export function craftModelFixture() {
  const { idempotencyKey, expectedRevision, ...input } = craftAnalysisFixture();
  return craftModelRecordSchema.parse({
    ...input,
    id: idempotencyKey,
    revision: (expectedRevision ?? 0) + 1,
    leagueId: randomUUID(),
    targetSignature: canonicalRecipeFixture.targetSignature,
    createdAt: craftFixtureAt,
  });
}
