import { describe, expect, it } from 'vitest';
import {
  expectedDefaultQueryHashes,
  expectedDefaultQueryKeys,
} from './integrationCatalog.js';
import { integrationScenario } from './integrationScenarios.js';

describe('integration scenarios', () =>
  it.each([
    ['all-success', 12],
    ['publish-at-95', 10],
    ['reject-below-95', 9],
  ] as const)(
    '%s keeps one shared legacy query with %i listings',
    async (name, count) => {
      const hashes = await expectedDefaultQueryHashes();
      const script = await integrationScenario(name);
      const step =
        script[
          hashes[expectedDefaultQueryKeys.indexOf('fixture:output:legacy')]!
        ]?.[0];
      expect(step?.type).toBe('success');
      expect(step?.type === 'success' ? step.result.listings : []).toHaveLength(
        count,
      );
    },
  ));
