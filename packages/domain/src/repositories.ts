import type {
  AggregatedObservation,
  CatalogProgress,
  Job,
  LeagueUpsert,
  JobKind,
  MarketQuery,
  NewAggregatedObservation,
  NewRawSnapshot,
  NewRecipeEvaluation,
  PublishedCatalog,
  RawSnapshot,
  RateLimitAcquireInput,
  RateLimitObservation,
  RateLimitPermit,
  RateLimitState,
  ProviderCircuitAcquireInput,
  ProviderCircuitFailureInput,
  ProviderCircuitPermit,
  ProviderCircuitState,
  ProviderCircuitSuccessInput,
  Recipe,
  RecipeEvaluation,
  RefreshCycle,
  PoeLeague,
  RetentionCleanupOptions,
  RetentionCleanupReport,
} from './models.js';

export interface RecipeRepository {
  findById(id: string): Promise<Recipe | null>;
  listAll(): Promise<Recipe[]>;
  listActive(): Promise<Recipe[]>;
  save(recipe: Recipe): Promise<Recipe>;
}

export interface LeagueRepository {
  findCurrent(): Promise<PoeLeague | null>;
  list(): Promise<PoeLeague[]>;
  setCurrent(leagueId: string, switchedAt: Date): Promise<PoeLeague>;
  upsert(input: LeagueUpsert): Promise<PoeLeague>;
}

export interface MarketQueryRepository {
  findByCanonicalHash(canonicalHash: string): Promise<MarketQuery | null>;
  save(query: MarketQuery): Promise<MarketQuery>;
}

export interface SnapshotRepository {
  deleteExpired(before: Date): Promise<number>;
  findLatest(
    marketQueryId: string,
    leagueId: string,
  ): Promise<RawSnapshot | null>;
  save(snapshot: NewRawSnapshot): Promise<{
    inserted: boolean;
    snapshot: RawSnapshot;
  }>;
}

export interface ObservationRepository {
  listRecent(
    marketQueryId: string,
    leagueId: string,
    since: Date,
  ): Promise<AggregatedObservation[]>;
  save(observation: NewAggregatedObservation): Promise<AggregatedObservation>;
}

export interface EvaluationRepository {
  findByRecipeAndCycle(
    recipeId: string,
    refreshCycleId: string,
  ): Promise<RecipeEvaluation | null>;
  listByCycle(refreshCycleId: string): Promise<RecipeEvaluation[]>;
  save(evaluation: NewRecipeEvaluation): Promise<RecipeEvaluation>;
}

export interface CycleRepository {
  findById(id: string): Promise<RefreshCycle | null>;
  getPublishedCycleId(): Promise<string | null>;
  publish(id: string, publishedAt: Date): Promise<boolean>;
  save(cycle: RefreshCycle): Promise<RefreshCycle>;
}

export interface CatalogRepository {
  getProgress(): Promise<CatalogProgress>;
  getPublished(): Promise<PublishedCatalog | null>;
}

export interface RetentionRepository {
  cleanup(options: RetentionCleanupOptions): Promise<RetentionCleanupReport>;
}

export interface RateLimitRepository {
  acquire(input: RateLimitAcquireInput): Promise<RateLimitPermit>;
  list(): Promise<RateLimitState[]>;
  observe(input: RateLimitObservation): Promise<RateLimitState>;
}

export interface ProviderCircuitRepository {
  acquire(input: ProviderCircuitAcquireInput): Promise<ProviderCircuitPermit>;
  list(): Promise<ProviderCircuitState[]>;
  recordFailure(
    input: ProviderCircuitFailureInput,
  ): Promise<ProviderCircuitState>;
  recordSuccess(
    input: ProviderCircuitSuccessInput,
  ): Promise<ProviderCircuitState>;
}

export type OperationalDiagnosticsSnapshot = {
  cycles: Array<{
    cycleId: string;
    leagueId: string;
    status: string;
    requestedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    publishedAt: Date | null;
    errorCode: string | null;
  }>;
  evaluations: Array<{
    cycleId: string;
    leagueId: string;
    recipeId: string;
    status: 'stale' | 'partial' | 'error';
    errorCode: string | null;
    evaluatedAt: Date;
  }>;
  jobs: Array<{
    jobId: string;
    cycleId: string | null;
    provider: string | null;
    queryHash: string | null;
    status: string;
    attempts: number;
    errorCode: string | null;
    updatedAt: Date;
  }>;
};

export interface OperationalDiagnosticsRepository {
  read(input: {
    recentCycles: number;
    recentFailures: number;
  }): Promise<OperationalDiagnosticsSnapshot>;
}

export interface JobRepository {
  claimNext(
    workerId: string,
    now: Date,
    kinds?: readonly JobKind[],
  ): Promise<Job | null>;
  complete(id: string, completedAt: Date): Promise<void>;
  enqueue(job: Job): Promise<Job>;
  fail(id: string, error: string, retryAt: Date, now: Date): Promise<void>;
  failPermanently(id: string, error: string, now: Date): Promise<void>;
  recoverStale(before: Date, retryAt: Date, now: Date): Promise<number>;
}

export interface MarketResultRepository {
  commitSuccess(result: {
    completedAt: Date;
    jobId: string;
    observation: NewAggregatedObservation;
    snapshot: NewRawSnapshot;
  }): Promise<{ applied: boolean }>;
}

export type Repositories = {
  catalog: CatalogRepository;
  cycles: CycleRepository;
  evaluations: EvaluationRepository;
  jobs: JobRepository;
  leagues: LeagueRepository;
  marketQueries: MarketQueryRepository;
  marketResults: MarketResultRepository;
  observations: ObservationRepository;
  operationalDiagnostics: OperationalDiagnosticsRepository;
  providerCircuits: ProviderCircuitRepository;
  rateLimits: RateLimitRepository;
  recipes: RecipeRepository;
  retention: RetentionRepository;
  snapshots: SnapshotRepository;
};
