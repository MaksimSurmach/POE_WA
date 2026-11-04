import {
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  type CatalogResponse,
  catalogResponseSchema,
  type RecipeResponse,
  recipeResponseSchema,
  type RefreshProgressResponse,
  refreshProgressResponseSchema,
  type CurrentLeagueResponse,
  currentLeagueResponseSchema,
  type LeaguesResponse,
  leaguesResponseSchema,
  type RefreshTriggerResponse,
  refreshTriggerResponseSchema,
  type RecipeTrendResponse,
  recipeTrendResponseSchema,
  type TrendOverviewResponse,
  trendOverviewResponseSchema,
  type TrendRange,
  craftingPricesResponseSchema,
  craftAnalysisResponseSchema,
  craftModelResponseSchema,
  craftModelSaveInputSchema,
  craftRiskResponseSchema,
  craftRiskCreateInputSchema,
  type CraftModelSaveInput,
  type CraftRiskCreateInput,
} from '@poe-worksmith/contracts';

type Contract<T> = {
  safeParse(value: unknown): { data: T; success: true } | { success: false };
};

export class ApiClientError extends Error {
  readonly envelope: ApiErrorEnvelope;

  constructor(envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'ApiClientError';
    this.envelope = envelope;
  }
}

export function createApiClient(
  baseUrl = '',
  fetchImplementation: typeof fetch = globalThis.fetch,
) {
  const root = baseUrl.replace(/\/$/, '');

  async function request<T>(
    path: string,
    contract: Contract<T>,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<T> {
    const response = await fetchImplementation(`${root}${path}`, {
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(method === 'POST' ? { method } : {}),
    });
    const payload: unknown = await response.json();
    const result = contract.safeParse(payload);
    if (result.success) return result.data;

    const error = apiErrorEnvelopeSchema.safeParse(payload);
    if (error.success) throw new ApiClientError(error.data);
    throw new Error('API response violated the shared contract');
  }

  return {
    getCraftAnalysis(id: string, league?: string) {
      return request(
        `/api/recipes/${encodeURIComponent(id)}/analysis${league ? `?league=${encodeURIComponent(league)}` : ''}`,
        craftAnalysisResponseSchema,
      );
    },
    saveCraftModel(input: CraftModelSaveInput) {
      return request(
        '/api/admin/craft-analysis/models',
        craftModelResponseSchema,
        'POST',
        craftModelSaveInputSchema.parse(input),
      );
    },
    createCraftRisk(input: CraftRiskCreateInput) {
      return request(
        '/api/admin/craft-analysis/simulations',
        craftRiskResponseSchema,
        'POST',
        craftRiskCreateInputSchema.parse(input),
      );
    },
    getCraftRisk(id: string) {
      return request(
        `/api/admin/craft-analysis/simulations/${encodeURIComponent(id)}`,
        craftRiskResponseSchema,
      );
    },
    cancelCraftRisk(id: string, idempotencyKey: string) {
      return request(
        `/api/admin/craft-analysis/simulations/${encodeURIComponent(id)}/cancel`,
        craftRiskResponseSchema,
        'POST',
        { idempotencyKey },
      );
    },
    getCraftingPrices() {
      return request('/api/crafting-prices', craftingPricesResponseSchema);
    },
    getCatalog(): Promise<CatalogResponse> {
      return request('/api/catalog', catalogResponseSchema);
    },
    getRecipe(id: string): Promise<RecipeResponse> {
      return request(
        `/api/recipes/${encodeURIComponent(id)}`,
        recipeResponseSchema,
      );
    },
    getRefreshFreshness(): Promise<RefreshProgressResponse> {
      return request('/api/refresh', refreshProgressResponseSchema);
    },
    triggerPriceRefresh(): Promise<RefreshTriggerResponse> {
      return request('/api/refresh', refreshTriggerResponseSchema, 'POST');
    },
    getCurrentLeague(): Promise<CurrentLeagueResponse> {
      return request('/api/leagues/current', currentLeagueResponseSchema);
    },
    getLeagues(): Promise<LeaguesResponse> {
      return request('/api/leagues', leaguesResponseSchema);
    },
    getTrendOverview(range: TrendRange): Promise<TrendOverviewResponse> {
      return request(
        `/api/trends?range=${encodeURIComponent(range)}`,
        trendOverviewResponseSchema,
      );
    },
    getRecipeTrend(
      id: string,
      range: TrendRange,
    ): Promise<RecipeTrendResponse> {
      return request(
        `/api/trends/${encodeURIComponent(id)}?range=${encodeURIComponent(range)}`,
        recipeTrendResponseSchema,
      );
    },
  };
}
