import type {
  ResolutionResult,
  ResolvedTradeBase,
  ResolvedTradeTarget,
  TradeMappingCatalog,
} from '@poe-worksmith/domain';
import type { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const mappingPayload = z
  .object({
    filters: z
      .record(
        z.string(),
        z.union([z.number().finite(), z.string(), z.boolean()]),
      )
      .optional(),
    maximum: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
  })
  .strict();
export type MappingInput = {
  canonicalId: string;
  discriminator?: string | undefined;
  entityKind: 'base' | 'mod' | 'modFamily' | 'resource';
  externalId: string;
  payload?: Record<string, unknown> | undefined;
};
const diagnostic = (code: string, entityId: string, message: string) => ({
  code,
  entityId,
  message,
  path: [],
  severity: 'error' as const,
});
const failure = <T>(
  code: string,
  entityId: string,
  message: string,
): ResolutionResult<T> => ({
  diagnostics: [diagnostic(code, entityId, message)],
  ok: false,
});
const manifestSchema = z.strictObject({
  gameDataVersion: z.string().min(1),
  mappingVersion: z.string().min(1),
  mappings: z
    .array(
      z.strictObject({
        canonicalId: z.string().min(1),
        discriminator: z.string().min(1).optional(),
        entityKind: z.enum(['base', 'mod', 'modFamily', 'resource']),
        externalId: z.string().min(1),
        payload: mappingPayload.optional(),
      }),
    )
    .min(1),
});

export async function loadAndValidateTradeMappingManifest(
  file: string,
  fetcher: typeof fetch = fetch,
): Promise<{
  gameDataVersion: string;
  mappings: MappingInput[];
  sourceRevision: string;
}> {
  const parsed = manifestSchema.safeParse(
    JSON.parse(await readFile(file, 'utf8')),
  );
  if (!parsed.success) throw new Error('PROVIDER_SCHEMA_CHANGED');
  const [items, stats] = await Promise.all(
    ['items', 'stats'].map(async (kind) => {
      const response = await fetcher(
        `https://www.pathofexile.com/api/trade/data/${kind}`,
      );
      if (!response.ok) throw new Error('PROVIDER_METADATA_UNAVAILABLE');
      return response.json() as Promise<unknown>;
    }),
  );
  const values = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? value.flatMap(values)
      : value && typeof value === 'object'
        ? [value, ...Object.values(value).flatMap(values)]
        : [];
  const itemTypes = new Set(
    values(items).flatMap((entry) =>
      typeof entry === 'object' &&
      entry &&
      'type' in entry &&
      typeof entry.type === 'string'
        ? [entry.type]
        : [],
    ),
  );
  const statIds = new Set(
    values(stats).flatMap((entry) =>
      typeof entry === 'object' &&
      entry &&
      'id' in entry &&
      typeof entry.id === 'string'
        ? [entry.id]
        : [],
    ),
  );
  for (const mapping of parsed.data.mappings) {
    const exists =
      mapping.entityKind === 'base' || mapping.entityKind === 'resource'
        ? itemTypes.has(mapping.externalId)
        : statIds.has(mapping.externalId);
    if (!exists)
      throw new Error(`PROVIDER_SCHEMA_CHANGED: ${mapping.externalId}`);
    for (const externalId of Object.keys(mapping.payload?.filters ?? {}))
      if (!statIds.has(externalId))
        throw new Error(`PROVIDER_SCHEMA_CHANGED: ${externalId}`);
  }
  return {
    gameDataVersion: parsed.data.gameDataVersion,
    mappings: parsed.data.mappings,
    sourceRevision: parsed.data.mappingVersion,
  };
}

export function createPostgresTradeMappingCatalog(
  pool: Pool,
): TradeMappingCatalog {
  const lookup = async (
    gameDataVersion: string,
    entityKind: MappingInput['entityKind'],
    canonicalId: string,
  ) => {
    const rows = await pool.query<{
      external_id: string;
      source_revision: string;
      discriminator: string | null;
      payload: Record<string, unknown>;
    }>(
      `select pm.external_id, pm.discriminator, pm.payload, pm.source_revision from provider_mappings pm join game_data_versions gdv on gdv.id = pm.game_data_version_id where gdv.patch_version = $1 and pm.provider = 'poe-trade' and pm.entity_kind = $2 and pm.canonical_id = $3 and pm.status = 'active'`,
      [gameDataVersion, entityKind, canonicalId],
    );
    return rows.rows;
  };
  return {
    async resolveBase({ gameDataVersion, baseId }) {
      const rows = await lookup(gameDataVersion, 'base', baseId);
      if (rows.length !== 1)
        return failure(
          rows.length ? 'TRADE_MAPPING_AMBIGUOUS' : 'TRADE_MAPPING_MISSING',
          baseId,
          `Expected one PoE Trade base mapping for ${baseId}`,
        );
      const payload = mappingPayload.safeParse(rows[0]!.payload);
      if (!payload.success)
        return failure(
          'PROVIDER_SCHEMA_CHANGED',
          baseId,
          'Stored PoE Trade base mapping payload is invalid',
        );
      return {
        diagnostics: [],
        ok: true,
        value: {
          id: rows[0]!.external_id,
          mappingVersion: rows[0]!.source_revision,
          ...(rows[0]!.discriminator
            ? { discriminator: rows[0]!.discriminator }
            : {}),
          ...(payload.data.filters ? { filters: payload.data.filters } : {}),
        } satisfies ResolvedTradeBase,
      };
    },
    async resolveTarget({ gameDataVersion, target }) {
      const entityKind = target.modId ? 'mod' : 'modFamily';
      const canonicalId = target.modId ?? target.modFamilyId!;
      const rows = await lookup(gameDataVersion, entityKind, canonicalId);
      if (rows.length !== 1)
        return failure(
          rows.length ? 'TRADE_MAPPING_AMBIGUOUS' : 'TRADE_MAPPING_MISSING',
          canonicalId,
          `Expected one PoE Trade target mapping for ${canonicalId}`,
        );
      const payload = mappingPayload.safeParse(rows[0]!.payload);
      if (!payload.success)
        return failure(
          'PROVIDER_SCHEMA_CHANGED',
          canonicalId,
          'Stored PoE Trade mapping payload is invalid',
        );
      return {
        diagnostics: [],
        ok: true,
        value: {
          id: rows[0]!.external_id,
          ...(payload.data.minimum === undefined
            ? {}
            : { minimum: payload.data.minimum }),
          ...(payload.data.maximum === undefined
            ? {}
            : { maximum: payload.data.maximum }),
        } satisfies ResolvedTradeTarget,
      };
    },
  };
}

export function createPostgresResourceResolver(pool: Pool) {
  return async (itemId: string, gameDataVersion: string) => {
    const result = await pool.query<{ external_id: string }>(
      `select pm.external_id from provider_mappings pm join game_data_versions gdv on gdv.id = pm.game_data_version_id where gdv.patch_version = $1 and pm.provider = 'poe-trade' and pm.entity_kind = 'resource' and pm.canonical_id = $2 and pm.status = 'active'`,
      [gameDataVersion, itemId],
    );
    if (result.rowCount !== 1)
      throw new Error(`TRADE_MAPPING_MISSING: ${itemId}`);
    return result.rows[0]!.external_id;
  };
}

export async function importTradeMappings(
  pool: Pool,
  input: {
    gameDataVersion: string;
    mappings: readonly MappingInput[];
    sourceRevision: string;
  },
) {
  const version = await pool.query<{ id: string }>(
    `select id from game_data_versions where patch_version = $1 and game = 'poe1'`,
    [input.gameDataVersion],
  );
  if (version.rowCount !== 1)
    throw new Error('TRADE_MAPPING_VERSION_NOT_FOUND');
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const mapping of input.mappings) {
      const payload = mappingPayload.safeParse(mapping.payload ?? {});
      if (!payload.success) throw new Error('PROVIDER_SCHEMA_CHANGED');
      await client.query(
        `insert into provider_mappings (game_data_version_id, provider, entity_kind, canonical_id, external_id, discriminator, payload, source_revision) values ($1, 'poe-trade', $2, $3, $4, $5, $6, $7) on conflict (game_data_version_id, provider, entity_kind, canonical_id, external_id) do update set discriminator = excluded.discriminator, payload = excluded.payload, source_revision = excluded.source_revision, status = 'active'`,
        [
          version.rows[0]!.id,
          mapping.entityKind,
          mapping.canonicalId,
          mapping.externalId,
          mapping.discriminator ?? null,
          payload.data,
          input.sourceRevision,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
