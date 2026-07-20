import type { CanonicalItemSpec } from './canonical/item.js';
import type { ResolutionResult } from './canonical/setup.js';

export type CanonicalBaseRecord = {
  id: string;
  name: string;
  itemClass: string;
  domain: string;
  tags: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
};
export type CanonicalModStat = { id: string; minimum: number; maximum: number };
export type CanonicalModRecord = {
  id: string;
  familyId: string;
  name: string;
  generationType: 'prefix' | 'suffix' | 'implicit' | 'enchant' | 'other';
  requiredLevel: number;
  tags: readonly string[];
  spawnWeights: readonly { tag: string; weight: number }[];
  stats: readonly CanonicalModStat[];
};
export type CanonicalModFamily = {
  id: string;
  modIds: readonly string[];
  name: string;
};
export type CanonicalTagRecord = { id: string; name: string };
export type CanonicalFossilRecord = {
  id: string;
  name: string;
  tagModifiers: readonly { tag: string; weight: number }[];
};
export type CanonicalClusterPassiveRecord = {
  statId: string;
  baseId: string;
  tags: readonly string[];
};
export type CanonicalEntity =
  | CanonicalBaseRecord
  | CanonicalModRecord
  | CanonicalModFamily
  | CanonicalTagRecord
  | CanonicalFossilRecord
  | CanonicalClusterPassiveRecord;
export type CanonicalEntityKind =
  'base' | 'mod' | 'modFamily' | 'tag' | 'fossil' | 'clusterPassive';
export type ModPoolQuery = {
  baseId: string;
  itemLevel: number;
  tags: readonly string[];
  influences: readonly string[];
  variant: CanonicalItemSpec['variant'];
};

export interface GameDataCatalog {
  version(): string;
  getBase(baseId: string): Promise<CanonicalBaseRecord | null>;
  getMod(modId: string): Promise<CanonicalModRecord | null>;
  getModFamily(familyId: string): Promise<CanonicalModFamily | null>;
  listModsForBase(input: ModPoolQuery): Promise<readonly CanonicalModRecord[]>;
  getTag(tagId: string): Promise<CanonicalTagRecord | null>;
  getFossil(fossilId: string): Promise<CanonicalFossilRecord | null>;
  getClusterPassive(
    statId: string,
  ): Promise<CanonicalClusterPassiveRecord | null>;
}

export type GameDataSource = {
  patchVersion: string;
  records: readonly { kind: CanonicalEntityKind; payload: CanonicalEntity }[];
  source: string;
  sourceRevision: string;
};
export type GameDataDiagnostic = {
  code: string;
  entityId?: string;
  message: string;
};
export class GameDataValidationError extends Error {
  constructor(readonly diagnostics: readonly GameDataDiagnostic[]) {
    super(
      diagnostics.map(({ code, message }) => `${code}: ${message}`).join('\n'),
    );
  }
}

function idOf(kind: CanonicalEntityKind, value: CanonicalEntity) {
  return kind === 'clusterPassive'
    ? (value as CanonicalClusterPassiveRecord).statId
    : (value as Exclude<CanonicalEntity, CanonicalClusterPassiveRecord>).id;
}
export function validateGameData(source: GameDataSource): void {
  const diagnostics: GameDataDiagnostic[] = [];
  const records = new Map<string, CanonicalEntity>();
  for (const { kind, payload } of source.records) {
    const id = idOf(kind, payload);
    const key = `${kind}:${id}`;
    if (!id.trim())
      diagnostics.push({
        code: 'GAME_DATA_INVALID_ID',
        message: 'Canonical ID is required',
      });
    else if (records.has(key))
      diagnostics.push({
        code: 'GAME_DATA_DUPLICATE_ID',
        entityId: id,
        message: `Duplicate ${kind}`,
      });
    else records.set(key, payload);
    if (kind === 'mod')
      for (const weight of (payload as CanonicalModRecord).spawnWeights)
        if (!Number.isInteger(weight.weight) || weight.weight < 0)
          diagnostics.push({
            code: 'GAME_DATA_INVALID_WEIGHT',
            entityId: id,
            message: `Invalid spawn weight for ${weight.tag}`,
          });
  }
  for (const { kind, payload } of source.records) {
    if (
      kind === 'mod' &&
      !records.has(`modFamily:${(payload as CanonicalModRecord).familyId}`)
    )
      diagnostics.push({
        code: 'GAME_DATA_MISSING_FAMILY',
        entityId: (payload as CanonicalModRecord).id,
        message: `Missing mod family ${(payload as CanonicalModRecord).familyId}`,
      });
    if (kind === 'modFamily')
      for (const modId of (payload as CanonicalModFamily).modIds)
        if (!records.has(`mod:${modId}`))
          diagnostics.push({
            code: 'GAME_DATA_MISSING_MOD',
            entityId: (payload as CanonicalModFamily).id,
            message: `Missing mod ${modId}`,
          });
  }
  if (diagnostics.length) throw new GameDataValidationError(diagnostics);
}

export function manifestHash(source: GameDataSource): string {
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(source)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class InMemoryGameDataCatalog implements GameDataCatalog {
  private readonly records = new Map<string, CanonicalEntity>();
  constructor(
    private readonly dataVersion: string,
    source: GameDataSource,
  ) {
    validateGameData(source);
    for (const { kind, payload } of source.records)
      this.records.set(
        `${kind}:${idOf(kind, payload)}`,
        structuredClone(payload),
      );
  }
  version() {
    return this.dataVersion;
  }
  private get<T extends CanonicalEntity>(
    kind: CanonicalEntityKind,
    id: string,
  ): T | null {
    const value = this.records.get(`${kind}:${id}`) as T | undefined;
    return value ? structuredClone(value) : null;
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
  async listModsForBase(input: ModPoolQuery) {
    const base = await this.getBase(input.baseId);
    if (!base) return [];
    const tags = new Set([...base.tags, ...input.tags, ...input.influences]);
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith('mod:'))
      .map(([, value]) => value as CanonicalModRecord)
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

export type ResolvedModPool = {
  gameDataVersion: string;
  mods: readonly CanonicalModRecord[];
};
export interface ModPoolResolver {
  resolve(input: CanonicalItemSpec): Promise<ResolutionResult<ResolvedModPool>>;
}
export class CatalogModPoolResolver implements ModPoolResolver {
  constructor(private readonly catalog: GameDataCatalog) {}
  async resolve(
    input: CanonicalItemSpec,
  ): Promise<ResolutionResult<ResolvedModPool>> {
    const base = await this.catalog.getBase(input.baseId);
    if (!base)
      return {
        ok: false,
        diagnostics: [
          {
            code: 'GAME_DATA_BASE_NOT_FOUND',
            entityId: input.baseId,
            message: 'Base is not in the active game-data version',
            path: ['baseId'],
            severity: 'error',
          },
        ],
      };
    if (
      input.variant.kind === 'cluster-jewel' &&
      !(await this.catalog.getClusterPassive(input.variant.smallPassiveStatId))
    )
      return {
        ok: false,
        diagnostics: [
          {
            code: 'GAME_DATA_CLUSTER_PASSIVE_NOT_FOUND',
            entityId: input.variant.smallPassiveStatId,
            message: 'Cluster passive is not in the active game-data version',
            path: ['variant', 'smallPassiveStatId'],
            severity: 'error',
          },
        ],
      };
    return {
      ok: true,
      diagnostics: [],
      value: {
        gameDataVersion: this.catalog.version(),
        mods: await this.catalog.listModsForBase({
          baseId: input.baseId,
          itemLevel: input.itemLevel,
          tags: base.tags,
          influences: input.influences,
          variant: input.variant,
        }),
      },
    };
  }
}
