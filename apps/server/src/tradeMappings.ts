import type {
  ResolutionResult,
  ResolvedTradeBase,
  ResolvedTradeTarget,
  TradeMappingCatalog,
} from '@poe-worksmith/domain';
import type { Pool } from 'pg';
import {
  isNativeTradeFilter,
  splitNativeTradeFilters,
} from '@poe-worksmith/domain';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const mappingPayload = z
  .object({
    exchangeId: z.string().min(1).optional(),
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
      const headers = new Headers();
      headers.set(
        'User-Agent',
        process.env.POE_USER_AGENT?.trim() ||
          'POE Worksmith trade mapping validator',
      );
      const response = await fetcher(
        `https://www.pathofexile.com/api/trade/data/${kind}`,
        { headers },
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
        : statIds.has(mapping.externalId) ||
          isNativeTradeFilter(mapping.externalId);
    if (!exists)
      throw new Error(`PROVIDER_SCHEMA_CHANGED: ${mapping.externalId}`);
    for (const [externalId, value] of Object.entries(
      mapping.payload?.filters ?? {},
    )) {
      if (isNativeTradeFilter(externalId)) {
        splitNativeTradeFilters([
          {
            type: 'and',
            filters: [{ id: externalId, value: { min: value, max: value } }],
          },
        ]);
      } else if (!statIds.has(externalId))
        throw new Error(`PROVIDER_SCHEMA_CHANGED: ${externalId}`);
    }
  }
  return {
    gameDataVersion: parsed.data.gameDataVersion,
    mappings: parsed.data.mappings,
    sourceRevision: parsed.data.mappingVersion,
  };
}

type ActiveTradeMapping = {
  external_id: string;
  source_revision: string;
  discriminator: string | null;
  payload: Record<string, unknown>;
};

const activeTradeMappings = `
  from provider_mappings pm join game_data_versions gdv on gdv.id = pm.game_data_version_id
  where gdv.status = 'active' and pm.provider = 'poe-trade' and pm.status = 'active'`;

export function createPostgresTradeMappingCatalog(
  pool: Pool,
): TradeMappingCatalog {
  return tradeMappingCatalog(
    async (gameDataVersion, entityKind, canonicalId) => {
      const result = await pool.query<ActiveTradeMapping>(
        `select pm.external_id, pm.discriminator, pm.payload, pm.source_revision ${activeTradeMappings}
       and gdv.patch_version = $1 and pm.entity_kind = $2 and pm.canonical_id = $3`,
        [gameDataVersion, entityKind, canonicalId],
      );
      return result.rows;
    },
  );
}

export async function loadTradeMappingCatalog(
  connection: Pick<Pool, 'query'>,
  gameDataVersions: string[],
): Promise<TradeMappingCatalog> {
  const { rows } = await connection.query<
    ActiveTradeMapping & {
      patch_version: string;
      entity_kind: MappingInput['entityKind'];
      canonical_id: string;
    }
  >(
    `select gdv.patch_version, pm.entity_kind, pm.canonical_id, pm.external_id, pm.discriminator, pm.payload, pm.source_revision
     ${activeTradeMappings}
       and gdv.patch_version = any($1::text[]) and pm.entity_kind in ('base', 'mod', 'modFamily')`,
    [gameDataVersions],
  );
  const mappings = new Map<string, ActiveTradeMapping[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.patch_version,
      row.entity_kind,
      row.canonical_id,
    ]);
    const entries = mappings.get(key);
    if (entries) entries.push(row);
    else mappings.set(key, [row]);
  }
  return tradeMappingCatalog(
    (...args) => mappings.get(JSON.stringify(args)) ?? [],
  );
}

function tradeMappingCatalog(
  lookup: (
    gameDataVersion: string,
    entityKind: MappingInput['entityKind'],
    canonicalId: string,
  ) => ActiveTradeMapping[] | Promise<ActiveTradeMapping[]>,
): TradeMappingCatalog {
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
    const result = await pool.query<{
      external_id: string;
      payload: Record<string, unknown>;
    }>(
      `select pm.external_id, pm.payload from provider_mappings pm join game_data_versions gdv on gdv.id = pm.game_data_version_id where gdv.patch_version = $1 and gdv.status = 'active' and pm.provider = 'poe-trade' and pm.entity_kind = 'resource' and pm.canonical_id = $2 and pm.status = 'active'`,
      [gameDataVersion, itemId],
    );
    if (result.rowCount !== 1) return null;
    const payload = mappingPayload.safeParse(result.rows[0]!.payload);
    if (!payload.success) throw new Error('PROVIDER_SCHEMA_CHANGED');
    return payload.data.exchangeId ?? null;
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
    `select id from game_data_versions where patch_version = $1 and game = 'poe1' and status = 'active'`,
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
