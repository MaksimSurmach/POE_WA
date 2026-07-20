export type JsonRecord = Readonly<Record<string, unknown>>;

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
  marketQueryId: string;
  payload: JsonRecord;
  providerStatus: number;
  refreshCycleId: string;
};

export type RawSnapshot = NewRawSnapshot & { id: number };

export type NewAggregatedObservation = {
  cheapestPrice: string | null;
  currency: string;
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
  errorCode: string | null;
  estimatedSalePrice: string | null;
  evaluatedAt: Date;
  expectedCraftCost: string | null;
  marginPercent: string | null;
  observationId: number | null;
  profit: string | null;
  recipeId: string;
  refreshCycleId: string;
  sourceSnapshotDedupeKey: string | null;
  status: EvaluationStatus;
};

export type RecipeEvaluation = NewRecipeEvaluation & { id: number };

export type RefreshCycleStatus =
  'queued' | 'running' | 'published' | 'failed' | 'superseded';

export type RefreshCycle = {
  completedQueries: number;
  completedRecipes: number;
  errorMessage: string | null;
  failedQueries: number;
  failedRecipes: number;
  finishedAt: Date | null;
  id: string;
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
