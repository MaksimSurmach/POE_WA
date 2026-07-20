import type {
  AggregatedObservation,
  Job,
  MarketQuery,
  NewAggregatedObservation,
  NewRawSnapshot,
  NewRecipeEvaluation,
  RawSnapshot,
  Recipe,
  RecipeEvaluation,
  RefreshCycle,
} from './models.js';

export interface RecipeRepository {
  findById(id: string): Promise<Recipe | null>;
  listAll(): Promise<Recipe[]>;
  listActive(): Promise<Recipe[]>;
  save(recipe: Recipe): Promise<Recipe>;
}

export interface MarketQueryRepository {
  findByCanonicalHash(canonicalHash: string): Promise<MarketQuery | null>;
  save(query: MarketQuery): Promise<MarketQuery>;
}

export interface SnapshotRepository {
  deleteExpired(before: Date): Promise<number>;
  findLatest(marketQueryId: string): Promise<RawSnapshot | null>;
  save(snapshot: NewRawSnapshot): Promise<{
    inserted: boolean;
    snapshot: RawSnapshot;
  }>;
}

export interface ObservationRepository {
  listRecent(
    marketQueryId: string,
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
  publish(id: string, publishedAt: Date): Promise<void>;
  save(cycle: RefreshCycle): Promise<RefreshCycle>;
}

export interface JobRepository {
  claimNext(workerId: string, now: Date): Promise<Job | null>;
  complete(id: string, completedAt: Date): Promise<void>;
  enqueue(job: Job): Promise<Job>;
  fail(id: string, error: string, retryAt: Date, now: Date): Promise<void>;
}

export type Repositories = {
  cycles: CycleRepository;
  evaluations: EvaluationRepository;
  jobs: JobRepository;
  marketQueries: MarketQueryRepository;
  observations: ObservationRepository;
  recipes: RecipeRepository;
  snapshots: SnapshotRepository;
};
