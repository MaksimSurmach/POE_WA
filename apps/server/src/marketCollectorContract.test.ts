import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { marketCollectionRunSchema } from '@poe-worksmith/contracts';

describe('Go collector persisted contract', () => {
  it('keeps fake runs demo and partial under the strict Node contract', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../services/market-collector/testdata/demo-run.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const run = marketCollectionRunSchema.parse(fixture);
    expect(run.dataKind).toBe('demo');
    expect(run.coverage).toBe('partial');
    expect(run.snapshotId).toBeNull();
  });
});
