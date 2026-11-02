import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAndValidateTradeMappingManifest } from './tradeMappings.js';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});
const metadata = {
  items: { result: [{ entries: [{ type: 'Large Cluster Jewel' }] }] },
  stats: {
    result: [
      {
        entries: [
          { id: 'enchant.stat_3086156145' },
          { id: 'explicit.stat_4188581520' },
        ],
      },
    ],
  },
};
const fetcher: typeof fetch = async (input) =>
  new Response(
    JSON.stringify(
      String(input).endsWith('/items') ? metadata.items : metadata.stats,
    ),
  );
let metadataHeaders: Headers | undefined;
const headerCheckingFetcher: typeof fetch = async (input, init) => {
  metadataHeaders = new Headers(init?.headers);
  return fetcher(input);
};
async function manifest(externalId = 'explicit.stat_4188581520') {
  directory = await mkdtemp(path.join(tmpdir(), 'trade-mappings-'));
  const file = path.join(directory, 'manifest.json');
  await writeFile(
    file,
    JSON.stringify({
      gameDataVersion: '3.26.0',
      mappingVersion: 'v1',
      mappings: [
        {
          entityKind: 'base',
          canonicalId: 'base',
          externalId: 'Large Cluster Jewel',
          payload: { filters: { 'enchant.stat_3086156145': 8 } },
        },
        { entityKind: 'mod', canonicalId: 'mod', externalId },
      ],
    }),
  );
  return file;
}
describe('curated PoE Trade mappings', () => {
  it('validates IDs and identifies the mapping client to PoE Trade', async () => {
    expect(
      await loadAndValidateTradeMappingManifest(
        await manifest(),
        headerCheckingFetcher,
      ),
    ).toMatchObject({ sourceRevision: 'v1' });
    expect(metadataHeaders?.get('User-Agent')).toBe(
      process.env.POE_USER_AGENT?.trim() ||
        'POE Worksmith trade mapping validator',
    );
  });
  it('fails stale declared IDs explicitly', async () =>
    await expect(
      loadAndValidateTradeMappingManifest(
        await manifest('explicit.stale'),
        fetcher,
      ),
    ).rejects.toThrow('PROVIDER_SCHEMA_CHANGED'));
});
