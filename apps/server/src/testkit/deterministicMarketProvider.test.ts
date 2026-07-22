import { hashMarketQuery } from '@poe-worksmith/domain';
import { describe, expect, it } from 'vitest';
import { DeterministicMarketProvider } from './deterministicMarketProvider.js';
import { FIXTURE_NOW } from './fixedClock.js';

describe('deterministic provider', () =>
  it('uses only hash scripts and consumes them exactly once', async () => {
    const request = {
      league: 'Fixture League',
      query: { fixtureKey: 'test' },
      schemaVersion: 1,
    } as const;
    const hash = await hashMarketQuery({ ...request, provider: 'poe-trade' });
    const provider = new DeterministicMarketProvider({
      [hash]: [
        {
          type: 'success',
          result: {
            fetchedAt: FIXTURE_NOW,
            listings: [],
            provider: 'poe-trade',
            totalResults: 0,
          },
        },
      ],
    });
    await provider.search(request);
    provider.assertCallsByHash(hash, 1);
    provider.assertTotalCalls(1);
    await expect(provider.search(request)).rejects.toThrow('script exhausted');
  }));
