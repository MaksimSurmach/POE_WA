import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export class Metrics {
  readonly registry: Registry;
  readonly refreshDuration: Histogram<'outcome'>;
  readonly marketJobDuration: Histogram<'provider' | 'outcome'>;
  readonly marketJobRetries: Counter<'provider' | 'error_code'>;
  readonly snapshotCache: Counter<'result'>;
  readonly recipeEvaluations: Counter<'status'>;
  readonly providerRequests: Counter<'provider' | 'endpoint' | 'outcome'>;
  readonly providerRequestDuration: Histogram<
    'provider' | 'endpoint' | 'outcome'
  >;

  constructor(registry = new Registry()) {
    this.registry = registry;
    collectDefaultMetrics({ register: registry });
    this.refreshDuration = new Histogram({
      name: 'poe_refresh_duration_seconds',
      help: 'Refresh duration.',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.marketJobDuration = new Histogram({
      name: 'poe_market_job_duration_seconds',
      help: 'Market job duration.',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    });
    this.marketJobRetries = new Counter({
      name: 'poe_market_job_retries_total',
      help: 'Market job retries.',
      labelNames: ['provider', 'error_code'],
      registers: [registry],
    });
    this.snapshotCache = new Counter({
      name: 'poe_snapshot_cache_total',
      help: 'Snapshot cache results.',
      labelNames: ['result'],
      registers: [registry],
    });
    this.recipeEvaluations = new Counter({
      name: 'poe_recipe_evaluations_total',
      help: 'Recipe evaluations.',
      labelNames: ['status'],
      registers: [registry],
    });
    this.providerRequests = new Counter({
      name: 'poe_provider_requests_total',
      help: 'Provider requests.',
      labelNames: ['provider', 'endpoint', 'outcome'],
      registers: [registry],
    });
    this.providerRequestDuration = new Histogram({
      name: 'poe_provider_request_duration_seconds',
      help: 'Provider request duration.',
      labelNames: ['provider', 'endpoint', 'outcome'],
      registers: [registry],
    });
  }
}
