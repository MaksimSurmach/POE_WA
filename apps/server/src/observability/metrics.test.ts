import { describe, expect, it } from 'vitest';

import { Metrics } from './metrics.js';

describe('Metrics', () => {
  it('uses isolated registries and only low-cardinality labels', async () => {
    const first = new Metrics();
    const second = new Metrics();
    first.marketJobRetries.inc({
      provider: 'poe-trade',
      error_code: 'PROVIDER_UNAVAILABLE',
    });
    const text = await first.registry.metrics();
    expect(text).toContain(
      'poe_market_job_retries_total{provider="poe-trade",error_code="PROVIDER_UNAVAILABLE"} 1',
    );
    expect(await second.registry.metrics()).not.toContain(
      'PROVIDER_UNAVAILABLE',
    );
  });
});
