import type { Pool, PoolClient } from 'pg';
import {
  DomainError,
  factoryBatchSchema,
  factoryEventSchema,
  projectFactoryBatch,
  type FactoryBatch,
  type FactoryEvent,
} from '@poe-worksmith/domain';
import { craftRequestHash } from './craftAnalysisRepository.js';

type Queryable = Pick<PoolClient, 'query'>;
export function createFactoryRepository(pool: Pool) {
  async function read(
    db: Queryable,
    id: string,
    asOf: string,
    version?: number,
  ) {
    const batch = await db.query<{ document: unknown }>(
      'select document from factory_batches where id=$1',
      [id],
    );
    if (!batch.rows[0]) throw new DomainError('PERSISTENCE_NOT_FOUND');
    const rows = await db.query<{ document: unknown }>(
      'select document from factory_events where batch_id=$1 and sequence <= $2 order by sequence',
      [id, version ?? 2000],
    );
    const document = factoryBatchSchema.parse(batch.rows[0].document);
    const events = rows.rows.map((r) => factoryEventSchema.parse(r.document));
    return {
      batch: document,
      events,
      // Batches and events were checked against the clock on insertion. A
      // concurrent create or append can commit after the read captured its clock.
      projection: projectFactoryBatch(
        document,
        events,
        new Date(
          Math.max(
            Date.parse(asOf),
            Date.parse(document.startedAt),
            ...events.map((e) => Date.parse(e.occurredAt)),
          ),
        ).toISOString(),
      ),
      version: events.length,
    };
  }
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new DomainError('PERSISTENCE_CONFLICT');
      throw error;
    } finally {
      client.release();
    }
  }
  async function lockKey(client: PoolClient, key: string) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `factory-mutation:${key}`,
    ]);
  }
  async function prior(db: Queryable, key: string, hash: string, asOf: string) {
    const found = await db.query<{
      request_hash: string;
      batch_id: string;
      result_version: number;
    }>(
      'select request_hash,batch_id,result_version from factory_mutations where idempotency_key=$1',
      [key],
    );
    if (!found.rows[0]) return null;
    if (found.rows[0].request_hash !== hash)
      throw new DomainError('PERSISTENCE_CONFLICT');
    return read(db, found.rows[0].batch_id, asOf, found.rows[0].result_version);
  }
  async function recordMutation(
    client: PoolClient,
    key: string,
    hash: string,
    batchId: string,
    version: number,
  ) {
    await client.query(
      'insert into factory_mutations(idempotency_key,request_hash,batch_id,result_version) values($1,$2,$3,$4)',
      [key, hash, batchId, version],
    );
  }
  return {
    async findMutation(key: string, hash: string, asOf: string) {
      return prior(pool, key, hash, asOf);
    },
    async create(
      batch: FactoryBatch,
      key: string,
      requestHash: string,
      asOf: string,
    ) {
      return transaction(async (client) => {
        await lockKey(client, key);
        const previous = await prior(client, key, requestHash, asOf);
        if (previous) return previous;
        projectFactoryBatch(batch, [], asOf);
        await client.query(
          'insert into factory_batches(id,recipe_id,league_id,document) values($1,$2,$3,$4)',
          [batch.id, batch.recipeId, batch.leagueId, batch],
        );
        await recordMutation(client, key, requestHash, batch.id, 0);
        return read(client, batch.id, asOf);
      });
    },
    async append(
      id: string,
      expectedVersion: number,
      event: FactoryEvent,
      key: string,
      asOf: string,
    ) {
      const requestHash = craftRequestHash({
        operation: 'event',
        id,
        expectedVersion,
        event,
      });
      return transaction(async (client) => {
        await lockKey(client, key);
        const previous = await prior(client, key, requestHash, asOf);
        if (previous) return previous;
        const lock = await client.query(
          'select id from factory_batches where id=$1 for update',
          [id],
        );
        if (!lock.rowCount) throw new DomainError('PERSISTENCE_NOT_FOUND');
        const current = await read(client, id, asOf);
        if (current.version !== expectedVersion || current.version >= 2000)
          throw new DomainError('PERSISTENCE_CONFLICT');
        projectFactoryBatch(current.batch, [...current.events, event], asOf);
        await client.query(
          'insert into factory_events(id,batch_id,sequence,document) values($1,$2,$3,$4)',
          [event.id, id, current.version + 1, event],
        );
        await recordMutation(client, key, requestHash, id, current.version + 1);
        return read(client, id, asOf);
      });
    },
    async get(id: string, asOf: string) {
      return read(pool, id, asOf);
    },
    async list(leagueId: string, asOf: string, limit: number, offset: number) {
      // A repeatable-read snapshot keeps total and event projections coherent during concurrent writes.
      return transaction(async (client) => {
        await client.query(
          'set transaction isolation level repeatable read read only',
        );
        const count = await client.query<{ count: string }>(
          'select count(*) from factory_batches where league_id=$1',
          [leagueId],
        );
        const ids = await client.query<{ id: string }>(
          'select id from factory_batches where league_id=$1 order by created_at desc,id limit $2 offset $3',
          [leagueId, limit, offset],
        );
        const batches = [];
        for (const row of ids.rows) {
          const record = await read(client, row.id, asOf);
          batches.push({
            batch: record.batch,
            projection: record.projection,
            version: record.version,
          });
        }
        return { batches, total: Number(count.rows[0]!.count), limit, offset };
      });
    },
  };
}
export type FactoryRepository = ReturnType<typeof createFactoryRepository>;
