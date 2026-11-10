import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApi } from './api.js';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { assertLocalBrowserFixtureDatabase } from './testkit/integrationScenarios.js';

assertLocalBrowserFixtureDatabase();
const pool = createDatabasePool({ ...loadDatabaseConfig(), maxConnections: 4 });
const token = 'ééa';
const local = { headers: { host: 'localhost' }, remoteAddress: '127.0.0.1' };
const remote = {
  headers: { host: 'worksmith.example' },
  remoteAddress: '192.0.2.1',
};
const authorized = {
  ...remote,
  headers: { ...remote.headers, authorization: `Bearer ${token}` },
};

function createApi(diagnosticsToken?: string) {
  const options = {
    collectorPool: pool,
    diagnosticsToken,
    triggerRefresh: async () => 'legacy',
  };
  return buildApi(
    pino({ level: 'silent' }),
    async () => {},
    async () => ({ active: null, published: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
}

const api = createApi(token);
const unconfigured = createApi();

beforeEach(async () => {
  await pool.query(
    'truncate run_requests, collector_state, collector_schedule cascade',
  );
  await pool.query(
    "delete from recipes where id in ('run-test-active', 'run-test-inactive')",
  );
  await pool.query(`
    insert into recipes
      (id, content_hash, title, category, craft_method, game_version, guide_markdown, definition, active)
    values
      ('run-test-active', 'run-test-active', 'A', 'jewel', 'chaos', '3.25', '', '{}', true),
      ('run-test-inactive', 'run-test-inactive', 'B', 'jewel', 'chaos', '3.25', '', '{}', false)
  `);
});

afterAll(async () => {
  await Promise.all([api.close(), unconfigured.close()]);
  await pool.query(
    'truncate run_requests, collector_state, collector_schedule cascade',
  );
  await pool.query(
    "delete from recipes where id in ('run-test-active', 'run-test-inactive')",
  );
  await pool.end();
});

describe('collector run request API', () => {
  it('commits one queued request for concurrent posts and wakes the collector', async () => {
    const listener = await pool.connect();
    try {
      const notified = vi.fn();
      listener.on('notification', notified);
      await listener.query('listen worksmith_wake');

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          api.inject({ ...local, method: 'POST', url: '/api/run' }),
        ),
      );

      expect(responses.map((response) => response.statusCode)).toEqual(
        Array(6).fill(202),
      );
      const { requestId } = responses[0]!.json<{ requestId: string }>();
      expect(responses.map((response) => response.json())).toEqual(
        Array(6).fill({ requestId }),
      );
      expect(
        (
          await pool.query(
            'select id, scope, recipe_id, state from run_requests',
          )
        ).rows,
      ).toEqual([
        { id: requestId, scope: 'all', recipe_id: null, state: 'queued' },
      ]);
      await vi.waitFor(() =>
        expect(notified).toHaveBeenCalledWith(
          expect.objectContaining({ channel: 'worksmith_wake' }),
        ),
      );

      await pool.query(
        "update run_requests set state = 'running' where id = $1",
        [requestId],
      );
      const next = await api.inject({
        ...local,
        method: 'POST',
        url: '/api/run',
      });
      expect(next.statusCode).toBe(202);
      expect(next.json().requestId).not.toBe(requestId);
    } finally {
      listener.release(true);
    }
  });

  it('queues only valid scopes and existing active recipes', async () => {
    const request = (payload: object | string) =>
      api.inject({
        ...local,
        method: 'POST',
        url: '/api/run',
        headers: { ...local.headers, 'content-type': 'application/json' },
        payload,
      });
    for (const payload of [
      { scope: 'all', recipeId: 'run-test-active' },
      { scope: 'recipe' },
      { scope: 'recipe', recipeId: '' },
      { scope: 'recipe', recipeId: 'run\0test' },
      { scope: 'bogus' },
      'null',
      '{',
    ]) {
      expect((await request(payload)).statusCode).toBe(400);
    }
    for (const recipeId of ['run-test-inactive', 'run-test-missing']) {
      expect((await request({ scope: 'recipe', recipeId })).statusCode).toBe(
        404,
      );
    }
    const all = await request({ scope: 'all' });
    const recipe = await request({
      scope: 'recipe',
      recipeId: 'run-test-active',
    });
    const duplicate = await request({
      scope: 'recipe',
      recipeId: 'run-test-active',
    });
    expect([all.statusCode, recipe.statusCode, duplicate.statusCode]).toEqual([
      202, 202, 202,
    ]);
    expect(duplicate.json()).toEqual(recipe.json());
    expect(all.json().requestId).not.toBe(recipe.json().requestId);
    expect(
      (
        await pool.query(
          'select scope, recipe_id from run_requests order by scope',
        )
      ).rows,
    ).toEqual([
      { scope: 'all', recipe_id: null },
      { scope: 'recipe', recipe_id: 'run-test-active' },
    ]);
  });

  it('guards both routes and keeps the bearer out of legacy writes', async () => {
    for (const [method, url] of [
      ['POST', '/api/run'],
      ['GET', '/api/collector/status'],
      ['HEAD', '/api/collector/status'],
    ] as const) {
      expect((await api.inject({ ...remote, method, url })).statusCode).toBe(
        401,
      );
      expect(
        (
          await api.inject({
            ...remote,
            method,
            url,
            headers: { ...remote.headers, authorization: 'Bearer ééb' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await unconfigured.inject({ ...authorized, method, url })).statusCode,
      ).toBe(401);
    }
    expect((await pool.query('select id from run_requests')).rows).toEqual([]);
    expect(
      (await api.inject({ ...authorized, method: 'POST', url: '/api/run' }))
        .statusCode,
    ).toBe(202);
    expect(
      (
        await api.inject({
          ...authorized,
          method: 'GET',
          url: '/api/collector/status',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await api.inject({ ...authorized, method: 'POST', url: '/api/refresh' }))
        .statusCode,
    ).toBe(401);
  });

  it('reports state, newest request, next runnable time and the collector advisory lock', async () => {
    const status = async () => {
      const response = await api.inject({
        ...local,
        method: 'GET',
        url: '/api/collector/status',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      return response.json();
    };
    expect(await status()).toEqual({
      collectorState: null,
      latestRequest: null,
      lockHeld: false,
      nextDueAt: null,
    });
    await pool.query(`
      insert into collector_state (last_run_status) values ('done');
      insert into run_requests (scope, state, requested_at) values
        ('all', 'done', '2026-11-10T00:00:00Z'),
        ('all', 'queued', '2026-11-10T01:00:00Z');
      insert into collector_schedule (kind, key, payload, interval_minutes, next_due_at, retry_at, leased_until, enabled) values
        ('economy', 'disabled', '{}', 30, '2026-11-10T00:00:00Z', null, null, false),
        ('league', 'backoff', '{}', 30, '2026-11-10T00:00:00Z', '2026-11-10T03:00:00Z', null, true),
        ('retention', 'leased', '{}', 30, '2026-11-10T01:00:00Z', null, '2026-11-10T04:00:00Z', true),
        ('economy', 'due', '{}', 30, '2026-11-10T02:00:00Z', null, null, true)
    `);
    const leader = await pool.connect();
    try {
      await leader.query(
        "select pg_advisory_lock(hashtext('poe-worksmith:collector'))",
      );
      expect(await status()).toMatchObject({
        collectorState: { id: 1, lastRunStatus: 'done' },
        latestRequest: {
          scope: 'all',
          state: 'queued',
          requestedAt: '2026-11-10T01:00:00.000Z',
        },
        lockHeld: true,
        nextDueAt: '2026-11-10T02:00:00.000Z',
      });
      await leader.query(
        "select pg_advisory_unlock(hashtext('poe-worksmith:collector'))",
      );
      await leader.query(
        "select pg_advisory_lock_shared(hashtext('poe-worksmith:collector'))",
      );
      expect((await status()).lockHeld).toBe(false);
    } finally {
      leader.release(true);
    }
    expect((await status()).lockHeld).toBe(false);
  });
});
