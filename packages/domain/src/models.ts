export type JsonRecord = Readonly<Record<string, unknown>>;

export type PoeLeague = {
  createdAt: Date;
  endAt: Date | null;
  game: string;
  gggId: string;
  id: string;
  isCurrent: boolean;
  metadata: JsonRecord;
  name: string;
  realm: string;
  startAt: Date | null;
  syncedAt: Date;
  updatedAt: Date;
};

export type LeagueUpsert = Omit<PoeLeague, 'id' | 'createdAt' | 'updatedAt'>;

export type Recipe = {
  active: boolean;
  category: string;
  contentHash: string;
  craftMethod: string;
  definition: JsonRecord;
  gameVersion: string;
  guideMarkdown: string;
  id: string;
  tags: readonly string[];
  title: string;
};

export type MarketQuery = {
  active: boolean;
  canonicalHash: string;
  id: string;
  provider: string;
  query: JsonRecord;
  recipeId: string;
};

export type NewRawSnapshot = {
  capturedAt: Date;
  dedupeKey: string;
  expiresAt: Date;
  leagueId: string;
  marketQueryId: string;
  payload: JsonRecord;
  providerStatus: number;
  refreshCycleId: string;
};

export type RawSnapshot = NewRawSnapshot & { id: number };

export type NewAggregatedObservation = {
  cheapestPrice: string | null;
  currency: string;
  leagueId: string;
  marketQueryId: string;
  medianTopNPrice: string | null;
  nthPrice: string | null;
  observedAt: Date;
  refreshCycleId: string;
  sampleSize: number;
  summary: JsonRecord;
};

export type AggregatedObservation = NewAggregatedObservation & { id: number };

export type EvaluationStatus = 'success' | 'stale' | 'partial' | 'error';

export type NewRecipeEvaluation = {
  confidence: 'low' | 'medium' | 'high' | null;
  currency: string | null;
  errorCode: string | null;
  estimatedSalePrice: string | null;
  evaluatedAt: Date;
  expectedCraftCost: string | null;
  lastSuccessfulAt: Date | null;
  leagueId: string;
  marginPercent: string | null;
  observationId: number | null;
  profit: string | null;
  recipeId: string;
  refreshCycleId: string;
  sourceSnapshotDedupeKey: string | null;
  status: EvaluationStatus;
};

export type RecipeEvaluation = NewRecipeEvaluation & { id: number };

export type PublishedCatalog = {
  cycle: RefreshCycle;
  evaluations: RecipeEvaluation[];
  recipes: Recipe[];
};

export type CatalogProgress = {
  active: RefreshCycle | null;
  published: RefreshCycle | null;
};

export type RefreshCycleStatus =
  'queued' | 'running' | 'completed' | 'published' | 'failed' | 'superseded';

export type RefreshCycle = {
  completedQueries: number;
  completedRecipes: number;
  errorMessage: string | null;
  failedQueries: number;
  failedRecipes: number;
  finishedAt: Date | null;
  id: string;
  leagueId: string;
  publishedAt: Date | null;
  requestedAt: Date;
  startedAt: Date | null;
  status: RefreshCycleStatus;
  totalQueries: number;
  totalRecipes: number;
};

export type JobStatus = 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';

export type JobKind = 'recipe_refresh' | 'catalog_publish' | 'snapshot_cleanup';

export type Job = {
  attempts: number;
  dedupeKey: string;
  id: string;
  kind: JobKind;
  lastError: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  marketQueryId: string | null;
  maxAttempts: number;
  payload: JsonRecord;
  priority: number;
  recipeId: string | null;
  refreshCycleId: string | null;
  runAfter: Date;
  status: JobStatus;
};

export type RetentionCleanupOptions = {
  batchSize: number;
  jobsBefore: Date;
  observationsBefore: Date;
  rawSnapshotsBefore: Date;
};

export type RetentionCleanupReport = {
  jobs: number;
  observations: number;
  rawSnapshots: number;
};

export type RateLimitWindow = {
  activeRestrictionSeconds: number;
  currentHits: number;
  maximumHits: number;
  periodSeconds: number;
  restrictionSeconds: number;
  rule: string;
};

export type RateLimitState = {
  blockedUntil: Date;
  endpoints: string[];
  lastResponseAt: Date | null;
  lastStatus: number | null;
  minimumDelayMs: number;
  nextRequestAt: Date;
  policy: string;
  updatedAt: Date;
  windows: RateLimitWindow[];
};

export type RateLimitPermit = {
  acquired: boolean;
  retryAt: Date;
  state: RateLimitState;
};

export type RateLimitAcquireInput = {
  conservativeDelayMs: number;
  endpoint: string;
  fallbackPolicy: string;
  now: Date;
};

export type RateLimitObservation = {
  blockedUntil: Date;
  endpoint: string;
  fallbackPolicy: string;
  minimumDelayMs: number;
  now: Date;
  policy: string;
  status: number;
  windows: RateLimitWindow[];
};

export type ProviderCircuitStatus = 'closed' | 'open' | 'half_open';

export type ProviderCircuitState = {
  consecutiveFailures: number;
  endpoint: string;
  lastFailureCode: string | null;
  openedAt: Date | null;
  probeLeaseUntil: Date | null;
  provider: string;
  retryAt: Date | null;
  status: ProviderCircuitStatus;
  updatedAt: Date;
};

export type ProviderCircuitPermit = {
  allowed: boolean;
  retryAt: Date | null;
  state: ProviderCircuitState;
};

export type ProviderCircuitAcquireInput = {
  endpoint: string;
  now: Date;
  probeLeaseMs: number;
  provider: string;
};

export type ProviderCircuitFailureInput = {
  cooldownMs: number;
  endpoint: string;
  errorCode: string;
  failureThreshold: number;
  now: Date;
  provider: string;
};

export type ProviderCircuitSuccessInput = {
  endpoint: string;
  now: Date;
  provider: string;
};
