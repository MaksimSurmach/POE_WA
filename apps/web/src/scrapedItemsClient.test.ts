import { describe, expect, it, vi } from 'vitest';

import {
  createScrapedItemsClient,
  ScrapedItemsError,
  ScrapedItemsRejected,
} from './scrapedItemsClient.js';
import { fixtureItem } from './mocks/scrapedItems.js';

const correlationId = '44444444-4444-4444-8444-444444444444';
const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('scraped items client', () => {
  it('sends the expected revision with a save and parses the shared contract', async () => {
    const fetcher = respond(200, {
      correlationId,
      data: { item: fixtureItem, schedule: 'synchronized' },
    });
    const client = createScrapedItemsClient(fetcher as never);
    const saved = await client.save(fixtureItem.id, {
      expectedRevision: 3,
      spec: fixtureItem.spec,
    });
    expect(saved.data.item.revision).toBe(3);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/settings/scraped-items/${fixtureItem.id}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedRevision: 3,
    });
  });

  it('turns a 422 into fixable diagnostics', async () => {
    const client = createScrapedItemsClient(
      respond(422, {
        correlationId,
        data: {
          status: 'rejected',
          diagnostics: [
            {
              code: 'MODIFIER_UNKNOWN',
              message: 'Unknown',
              path: 'conditions.0',
            },
          ],
        },
      }) as never,
    );
    await expect(
      client.save(fixtureItem.id, {
        expectedRevision: 1,
        spec: fixtureItem.spec,
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ScrapedItemsRejected &&
        error.diagnostics[0]?.path === 'conditions.0',
    );
  });

  it('recognizes a stale revision as a conflict', async () => {
    const client = createScrapedItemsClient(
      respond(409, {
        correlationId,
        error: {
          category: 'persistence',
          code: 'PERSISTENCE_CONFLICT',
          disposition: 'permanent',
          message: 'The requested data change conflicts with current state.',
          retryable: false,
        },
      }) as never,
    );
    await expect(client.startTest(fixtureItem.id, 1)).rejects.toSatisfy(
      (error) => error instanceof ScrapedItemsError && error.conflict,
    );
  });

  it('rejects a response that breaks the contract instead of rendering it', async () => {
    const client = createScrapedItemsClient(
      respond(200, { correlationId, data: { items: 'nope' } }) as never,
    );
    await expect(client.list()).rejects.toThrow(/shared contract/);
  });

  it('encodes recipe ids and carries the revision when unlinking', async () => {
    const fetcher = respond(200, {
      correlationId,
      data: { item: fixtureItem, schedule: 'deferred' },
    });
    await createScrapedItemsClient(fetcher as never).unlink(
      fixtureItem.id,
      'a/b c',
      7,
    );
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/recipes/a%2Fb%20c?expectedRevision=7');
    expect(init.method).toBe('DELETE');
  });
});
