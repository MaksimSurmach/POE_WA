import {
  scrapedItemInfluences,
  scrapedItemSpecSchema,
  scrapedItemMarketCategoryLabels,
  type ScrapedItemCondition,
  type ScrapedItemSpec,
} from '@poe-worksmith/domain';
import type { ScrapedItem, ScrapedItemTest } from '@poe-worksmith/contracts';

export function scrapedSearchName(item: ScrapedItem) {
  return item.spec.marketSearchCategory
    ? `All ${scrapedItemMarketCategoryLabels[item.spec.marketSearchCategory].toLowerCase()}`
    : (item.baseName ?? item.baseId);
}

export type ConditionDraft = {
  kind: ScrapedItemCondition['kind'];
  // Canonical identity; the editor never lets it be typed free-hand.
  modId?: string;
  modFamilyId?: string;
  name: string | null;
  minimumValue: string;
  maximumValue: string;
  tierMode: 'any' | 'exact' | 'range';
  exactTier: string;
  minimumTier: string;
  maximumTier: string;
};
export type ItemDraft = {
  baseId: string;
  marketEquivalent: boolean;
  marketSearchCategory: string;
  itemLevel: string;
  rarity: ScrapedItemSpec['item']['rarity'];
  influences: string[];
  corrupted: boolean;
  fractured: boolean;
  synthesised: boolean;
  conditions: ConditionDraft[];
};
export type FieldError = { path: string; message: string };

const text = (value: number | undefined) =>
  value === undefined ? '' : String(value);

export function draftFromSpec(
  spec: ScrapedItemSpec,
  names: readonly (string | null)[] = [],
): ItemDraft {
  return {
    baseId: spec.item.baseId,
    marketEquivalent: spec.marketEquivalent === true,
    marketSearchCategory: spec.marketSearchCategory ?? '',
    itemLevel: String(spec.item.itemLevel),
    rarity: spec.item.rarity,
    influences: [...spec.item.influences],
    corrupted: spec.item.state.corrupted,
    fractured: spec.item.state.fractured,
    synthesised: spec.item.state.synthesised,
    conditions: spec.conditions.map((condition, index) => ({
      kind: condition.kind,
      ...(condition.modId ? { modId: condition.modId } : {}),
      ...(condition.modFamilyId ? { modFamilyId: condition.modFamilyId } : {}),
      name: names[index] ?? null,
      minimumValue: text(condition.minimumValue),
      maximumValue: text(condition.maximumValue),
      tierMode:
        condition.exactTier !== undefined
          ? 'exact'
          : condition.minimumTier !== undefined ||
              condition.maximumTier !== undefined
            ? 'range'
            : 'any',
      exactTier: text(condition.exactTier),
      minimumTier: text(condition.minimumTier),
      maximumTier: text(condition.maximumTier),
    })),
  };
}

function number(
  raw: string,
  path: string,
  label: string,
  errors: FieldError[],
  integer = false,
) {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    errors.push({
      path,
      message: `${label} must be ${integer ? 'a whole' : 'a'} number.`,
    });
    return undefined;
  }
  return value;
}

// Schema messages name constraints, not fields; say what the owner can do.
function friendlyIssue(path: string, message: string) {
  if (path === 'item.itemLevel')
    return 'Item level must be a whole number from 1 to 100.';
  if (/(exactTier|minimumTier|maximumTier)$/.test(path))
    return /^Too (big|small)|Invalid input/.test(message)
      ? 'Tier must be a whole number from 1 to 20.'
      : message;
  return message;
}

/** Turns what the owner typed into a spec, or says exactly which field to fix. */
export function specFromDraft(
  spec: ScrapedItemSpec,
  draft: ItemDraft,
): { ok: true; spec: ScrapedItemSpec } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const itemLevel = number(
    draft.itemLevel,
    'item.itemLevel',
    'Item level',
    errors,
    true,
  );
  if (itemLevel === undefined && !errors.length)
    errors.push({ path: 'item.itemLevel', message: 'Enter an item level.' });
  const conditions = draft.conditions.map((condition, index) => {
    const at = `conditions.${index}`;
    const name = condition.name ?? condition.modId ?? condition.modFamilyId;
    const minimumValue = number(
      condition.minimumValue,
      `${at}.minimumValue`,
      `${name} minimum`,
      errors,
    );
    const maximumValue = number(
      condition.maximumValue,
      `${at}.maximumValue`,
      `${name} maximum`,
      errors,
    );
    const exactTier =
      condition.tierMode === 'exact'
        ? number(
            condition.exactTier,
            `${at}.exactTier`,
            `${name} tier`,
            errors,
            true,
          )
        : undefined;
    const minimumTier =
      condition.tierMode === 'range'
        ? number(
            condition.minimumTier,
            `${at}.minimumTier`,
            `${name} minimum tier`,
            errors,
            true,
          )
        : undefined;
    const maximumTier =
      condition.tierMode === 'range'
        ? number(
            condition.maximumTier,
            `${at}.maximumTier`,
            `${name} maximum tier`,
            errors,
            true,
          )
        : undefined;
    return {
      kind: condition.kind,
      excluded: false as const,
      ...(condition.modId ? { modId: condition.modId } : {}),
      ...(condition.modFamilyId ? { modFamilyId: condition.modFamilyId } : {}),
      ...(minimumValue === undefined ? {} : { minimumValue }),
      ...(maximumValue === undefined ? {} : { maximumValue }),
      ...(exactTier === undefined ? {} : { exactTier }),
      ...(minimumTier === undefined ? {} : { minimumTier }),
      ...(maximumTier === undefined ? {} : { maximumTier }),
    };
  });
  if (errors.length) return { ok: false, errors };
  const identity = { ...spec };
  delete identity.marketEquivalent;
  delete identity.marketSearchCategory;
  const parsed = scrapedItemSpecSchema.safeParse({
    ...identity,
    ...(draft.marketEquivalent
      ? {
          marketEquivalent: true,
        }
      : spec.marketEquivalent === false
        ? { marketEquivalent: false }
        : {}),
    ...(draft.marketSearchCategory
      ? { marketSearchCategory: draft.marketSearchCategory }
      : {}),
    item: {
      ...spec.item,
      baseId: draft.baseId,
      variant:
        draft.baseId === spec.item.baseId
          ? spec.item.variant
          : { kind: 'none' },
      itemLevel,
      rarity: draft.rarity,
      influences: draft.influences,
      state: {
        corrupted: draft.corrupted,
        fractured: draft.fractured,
        synthesised: draft.synthesised,
      },
    },
    conditions,
  });
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: friendlyIssue(issue.path.join('.'), issue.message),
      })),
    };
  return { ok: true, spec: parsed.data };
}

export function isDirty(spec: ScrapedItemSpec, draft: ItemDraft) {
  const next = specFromDraft(spec, draft);
  // An unparsable draft is a change the owner has not finished. Both sides go
  // through the schema so key order cannot make an untouched draft look edited.
  return (
    !next.ok ||
    JSON.stringify(next.spec) !==
      JSON.stringify(scrapedItemSpecSchema.parse(spec))
  );
}

export const influenceOptions = scrapedItemInfluences;

export const testStateLabel: Record<ScrapedItemTest['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  failed: 'Failed',
  succeeded: 'Succeeded',
};
export const testIsActive = (state: ScrapedItemTest['state']) =>
  state === 'queued' || state === 'running';

// Plain-language reasons for the collector codes an owner will actually see.
const reasonText: Record<string, string> = {
  COLLECTIONS_PAUSED: 'Collection is paused.',
  COLLECTOR_NO_ELIGIBLE_TARGETS:
    'The collector has no enabled search for this configuration.',
  MARKET_ACCESS_BLOCKED: 'Trade access is not enabled for this deployment.',
  PROVIDER_ACCESS_DENIED: 'The Trade site refused the request (HTTP 403).',
  PROVIDER_AUTH_FAILED: 'The Trade session was rejected.',
  PROVIDER_CHALLENGE:
    'The Trade site asked for a browser challenge (HTTP 403). Collection stays paused until the session is restored.',
  PROVIDER_RATE_LIMITED:
    'The Trade site rate-limited the collector. It will retry after the limit window.',
  PROVIDER_UNAVAILABLE: 'The Trade site was unavailable.',
  SCHEDULE_UNAVAILABLE:
    'The search was replaced or disabled before it could run.',
  TRADE_ACCESS_BLOCKED: 'Trade collection is blocked.',
  TRADE_SESSION_DECRYPT_FAILED: 'The stored Trade session cannot be read.',
  TRADE_SESSION_KEY_INVALID: 'The Trade session key is not configured.',
};
export const reasonLabel = (code: string) =>
  reasonText[code] ? `${reasonText[code]} (${code})` : code;

const coverageNotes: Record<string, string> = {
  DETAILS_INCOMPLETE: 'Some listings could not be fetched in full.',
  MIXED_CURRENCY_SLICE_UNPROVEN:
    'Mixed-currency results were too large to slice safely.',
  MIXED_CURRENCY_TOTAL_MISMATCH:
    'Chaos and divine result totals did not add up.',
  PRICE_SLICE_LIMIT: 'The result set needed more price slices than allowed.',
  PRICE_SLICE_UNRESOLVED: 'A price slice could not be narrowed further.',
  SEARCH_CHANGED_DURING_CAPTURE: 'The market changed while collecting.',
  SEARCH_INEXACT: 'The Trade site marked the result list as inexact.',
  SEARCH_TOTAL_MISMATCH:
    'Fetched listings did not add up to the reported total.',
  SEARCH_TRUNCATED: 'The result list was cut off before all listings.',
};
export const partialReasonLabel = (code: string) =>
  coverageNotes[code] ? `${coverageNotes[code]} (${code})` : code;
