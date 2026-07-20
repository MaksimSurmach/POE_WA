import { createInMemoryRepositories, DomainError } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';

import {
  HttpPoeNinjaLeagueClient,
  HttpPoeTradeLeagueClient,
  LeagueResolver,
} from './leagues.js';

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('LeagueResolver', () => {
  it('switches from Standard only when both exact IDs agree and is idempotent', async () => {
    const repositories = createInMemoryRepositories();
    const resolver = new LeagueResolver({
      leagues: repositories.leagues,
      trade: { fetchLeagueIds: async () => ['Standard', 'Challenge'] },
      poeNinja: {
        fetchEconomyLeagues: async () => [
          { id: 'Standard', name: 'Standard' },
          { id: 'Challenge', name: 'Challenge' },
        ],
      },
    });
    const now = new Date('2026-07-21T00:00:00.000Z');
    const first = await resolver.resolve(now);
    const second = await resolver.resolve(now);
    expect(first).toMatchObject({
      selectedLeagueId: 'Challenge',
      switched: true,
    });
    expect(second.switched).toBe(false);
    expect((await repositories.leagues.findCurrent())?.gggId).toBe('Challenge');
  });

  it('keeps the persisted league on disagreement and treats IDs as case-sensitive', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.leagues.upsert({
      game: 'poe1',
      realm: 'pc',
      gggId: 'Old',
      name: 'Old',
      startAt: null,
      endAt: null,
      isCurrent: false,
      syncedAt: new Date(),
      metadata: {},
    });
    await repositories.leagues.setCurrent(
      (await repositories.leagues.list())[0]!.id,
      new Date(),
    );
    const resolver = new LeagueResolver({
      leagues: repositories.leagues,
      trade: { fetchLeagueIds: async () => ['challenge'] },
      poeNinja: {
        fetchEconomyLeagues: async () => [
          { id: 'Challenge', name: 'Challenge' },
        ],
      },
    });
    await resolver.resolve();
    expect((await repositories.leagues.findCurrent())?.gggId).toBe('Old');
  });

  it('separates unavailable and invalid source responses', async () => {
    const trade = new HttpPoeTradeLeagueClient({
      userAgent: 'test',
      requestTimeoutMs: 1000,
      fetch: async () => response({}),
    });
    const ninja = new HttpPoeNinjaLeagueClient({
      userAgent: 'test',
      requestTimeoutMs: 1000,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(trade.fetchLeagueIds()).rejects.toMatchObject({
      code: 'POE_TRADE_LEAGUES_INVALID',
    } satisfies Partial<DomainError>);
    await expect(ninja.fetchEconomyLeagues()).rejects.toMatchObject({
      code: 'POE_NINJA_LEAGUES_UNAVAILABLE',
    } satisfies Partial<DomainError>);
  });
});
