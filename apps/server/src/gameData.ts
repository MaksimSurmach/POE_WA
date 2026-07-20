import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  CatalogModPoolResolver,
  type CanonicalBaseRecord,
  type CanonicalClusterPassiveRecord,
  type CanonicalEntity,
  type CanonicalEntityKind,
  type CanonicalFossilRecord,
  type CanonicalModFamily,
  type CanonicalModRecord,
  type CanonicalTagRecord,
  type GameDataCatalog,
  type GameDataSource,
  validateGameData,
} from '@poe-worksmith/domain';
import type { Pool } from 'pg';
import { z } from 'zod';

const sourceSchema = z.strictObject({
  patchVersion: z.string().min(1),
  records: z.array(
    z.strictObject({
      kind: z.enum([
        'base',
        'mod',
        'modFamily',
        'tag',
        'fossil',
        'clusterPassive',
      ]),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  source: z.string().min(1),
  sourceRevision: z.string().min(1),
});

export async function loadGameDataSource(
  file: string,
): Promise<GameDataSource> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `GAME_DATA_SOURCE_PARSE: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = sourceSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `GAME_DATA_SOURCE_SCHEMA_DRIFT: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data as unknown as GameDataSource;
}

function idOf(kind: CanonicalEntityKind, value: CanonicalEntity) {
  return kind === 'clusterPassive'
    ? (value as CanonicalClusterPassiveRecord).statId
    : (value as Exclude<CanonicalEntity, CanonicalClusterPassiveRecord>).id;
}
function payloadHash(payload: CanonicalEntity) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export type GameDataRepository = {
  activate(versionId: string): Promise<void>;
  import(source: GameDataSource): Promise<string>;
  openActive(): Promise<GameDataCatalog | null>;
};

export function createGameDataRepository(pool: Pool): GameDataRepository {
  return {
    async import(source) {
      validateGameData(source);
      const manifestHash = createHash('sha256')
        .update(JSON.stringify(source))
        .digest('hex');
      const client = await pool.connect();
      try {
        await client.query('begin');
        const version = await client.query<{ id: string }>(
          `insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash) values ('poe1', $1, $2, $3, $4) returning id`,
          [
            source.patchVersion,
            source.source,
            source.sourceRevision,
            manifestHash,
          ],
        );
        const versionId = version.rows[0]!.id;
        for (const { kind, payload } of source.records)
          await client.query(
            `insert into canonical_entities (game_data_version_id, entity_kind, canonical_id, payload, payload_hash) values ($1, $2, $3, $4, $5)`,
            [
              versionId,
              kind,
              idOf(kind, payload),
              payload,
              payloadHash(payload),
            ],
          );
        await client.query('commit');
        return versionId;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async activate(versionId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const candidate = await client.query<{ id: string }>(
          `select id from game_data_versions where id = $1 and game = 'poe1' and status = 'importing' for update`,
          [versionId],
        );
        if (!candidate.rowCount)
          throw new Error('GAME_DATA_VERSION_NOT_ACTIVATABLE');
        await client.query(
          `update game_data_versions set status = 'archived' where game = 'poe1' and status = 'active'`,
        );
        await client.query(
          `update game_data_versions set status = 'active', activated_at = now() where id = $1`,
          [versionId],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async openActive() {
      const result = await pool.query<{ id: string; patch_version: string }>(
        `select id, patch_version from game_data_versions where game = 'poe1' and status = 'active'`,
      );
      const version = result.rows[0];
      if (!version) return null;
      const rows = await pool.query<{
        entity_kind: CanonicalEntityKind;
        payload: CanonicalEntity;
      }>(
        `select entity_kind, payload from canonical_entities where game_data_version_id = $1`,
        [version.id],
      );
      return new PostgresGameDataCatalog(version.patch_version, rows.rows);
    },
  };
}

class PostgresGameDataCatalog implements GameDataCatalog {
  constructor(
    private readonly dataVersion: string,
    private readonly rows: readonly {
      entity_kind: CanonicalEntityKind;
      payload: CanonicalEntity;
    }[],
  ) {}
  version() {
    return this.dataVersion;
  }
  private get<T extends CanonicalEntity>(
    kind: CanonicalEntityKind,
    id: string,
  ): T | null {
    const row = this.rows.find(
      (entry) => entry.entity_kind === kind && idOf(kind, entry.payload) === id,
    );
    return row ? structuredClone(row.payload as T) : null;
  }
  async getBase(id: string) {
    return this.get<CanonicalBaseRecord>('base', id);
  }
  async getMod(id: string) {
    return this.get<CanonicalModRecord>('mod', id);
  }
  async getModFamily(id: string) {
    return this.get<CanonicalModFamily>('modFamily', id);
  }
  async getTag(id: string) {
    return this.get<CanonicalTagRecord>('tag', id);
  }
  async getFossil(id: string) {
    return this.get<CanonicalFossilRecord>('fossil', id);
  }
  async getClusterPassive(id: string) {
    return this.get<CanonicalClusterPassiveRecord>('clusterPassive', id);
  }
  async listModsForBase(
    input: Parameters<GameDataCatalog['listModsForBase']>[0],
  ) {
    const base = await this.getBase(input.baseId);
    const tags = new Set([
      ...(base?.tags ?? []),
      ...input.tags,
      ...input.influences,
    ]);
    return this.rows
      .filter(({ entity_kind }) => entity_kind === 'mod')
      .map(({ payload }) => payload as CanonicalModRecord)
      .filter(
        (mod) =>
          mod.requiredLevel <= input.itemLevel &&
          mod.spawnWeights.some(
            ({ tag, weight }) => weight > 0 && tags.has(tag),
          ),
      )
      .map((mod) => structuredClone(mod));
  }
}

export { CatalogModPoolResolver };
