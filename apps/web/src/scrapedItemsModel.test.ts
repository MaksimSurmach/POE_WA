import { describe, expect, it } from 'vitest';

import { fixtureItem } from './mocks/scrapedItems.js';
import {
  draftFromSpec,
  isDirty,
  reasonLabel,
  specFromDraft,
} from './scrapedItemsModel.js';

const spec = fixtureItem.spec;

describe('scraped item drafts', () => {
  it('preserves equivalent market scope and removes it when strict matching is selected', () => {
    const equivalent = {
      ...spec,
      marketEquivalent: true,
      marketSearchCategory: 'accessory.ring' as const,
    };
    const draft = draftFromSpec(equivalent);
    expect(specFromDraft(equivalent, draft)).toEqual({
      ok: true,
      spec: equivalent,
    });
    const strict = specFromDraft(equivalent, {
      ...draft,
      marketEquivalent: false,
    });
    expect(strict).toEqual({ ok: true, spec });
    expect(isDirty(equivalent, { ...draft, marketEquivalent: false })).toBe(
      true,
    );
  });
  it('round-trips canonical IDs and values without change', () => {
    const draft = draftFromSpec(spec, ['Battle-Hardened', null]);
    expect(draft.conditions[0]).toMatchObject({
      modId: 'mod:battle-hardened',
      name: 'Battle-Hardened',
      minimumValue: '5',
      tierMode: 'any',
    });
    expect(isDirty(spec, draft)).toBe(false);
    const rebuilt = specFromDraft(spec, draft);
    expect(rebuilt.ok && rebuilt.spec).toEqual(spec);
    const explicitStrict = { ...spec, marketEquivalent: false };
    expect(isDirty(explicitStrict, draftFromSpec(explicitStrict))).toBe(false);
  });

  it('reports edits and reverts as dirty or clean', () => {
    const draft = draftFromSpec(spec);
    expect(isDirty(spec, { ...draft, itemLevel: '84' })).toBe(true);
    expect(isDirty(spec, { ...draft, itemLevel: '83' })).toBe(false);
    expect(isDirty(spec, { ...draft, itemLevel: 'abc' })).toBe(true);
  });

  it.each([
    [
      'a non-numeric item level',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.itemLevel = 'x';
      },
      'item.itemLevel',
    ],
    [
      'an item level above 100',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.itemLevel = '101';
      },
      'item.itemLevel',
    ],
    [
      'a fractional tier',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.conditions[0]!.tierMode = 'exact';
        d.conditions[0]!.exactTier = '1.5';
      },
      'conditions.0.exactTier',
    ],
    [
      'a tier above 20',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.conditions[0]!.tierMode = 'exact';
        d.conditions[0]!.exactTier = '21';
      },
      'conditions.0.exactTier',
    ],
    [
      'an inverted value range',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.conditions[0]!.minimumValue = '9';
        d.conditions[0]!.maximumValue = '3';
      },
      'conditions.0.minimumValue',
    ],
    [
      'a value beyond the bound',
      (d: ReturnType<typeof draftFromSpec>) => {
        d.conditions[0]!.maximumValue = '1e9';
      },
      'conditions.0.minimumValue',
    ],
  ])('refuses %s and names the field', (_name, change, path) => {
    const draft = draftFromSpec(spec);
    change(draft);
    const result = specFromDraft(spec, draft);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.path)).toContain(path);
  });

  it('keeps tier fields only for the chosen tier mode', () => {
    const draft = draftFromSpec(spec);
    draft.conditions[0]!.tierMode = 'range';
    draft.conditions[0]!.minimumTier = '1';
    draft.conditions[0]!.maximumTier = '3';
    draft.conditions[0]!.exactTier = '9';
    const result = specFromDraft(spec, draft);
    expect(result.ok && result.spec.conditions[0]).toMatchObject({
      minimumTier: 1,
      maximumTier: 3,
    });
    expect(result.ok && result.spec.conditions[0]).not.toHaveProperty(
      'exactTier',
    );
  });

  it('never produces an excluded condition', () => {
    const result = specFromDraft(spec, draftFromSpec(spec));
    expect(result.ok && result.spec.conditions.every((c) => !c.excluded)).toBe(
      true,
    );
  });
});

describe('collector reasons', () => {
  it('explains known codes and keeps unknown codes visible', () => {
    expect(reasonLabel('PROVIDER_CHALLENGE')).toContain('HTTP 403');
    expect(reasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
