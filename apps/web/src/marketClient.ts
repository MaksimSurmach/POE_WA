import {
  beltAnalysisResponseSchema,
  beltOpportunitiesResponseSchema,
  beltPriceUpdateSchema,
  beltPriceUpdatesResponseSchema,
  marketWorkbenchResponseSchema,
  marketCollectionResponseSchema,
  marketCollectionSettingsResponseSchema,
  marketCollectionRunResponseSchema,
  marketTargetResponseSchema,
  marketResearchSnapshotResponseSchema,
  type MarketTargetInput,
  type MarketSnapshotImport,
  type MarketCollectionSettingsInput,
  type BeltPriceUpdateInput,
} from '@poe-worksmith/contracts';

async function request(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<unknown> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : null;
    const message =
      detail &&
      typeof detail === 'object' &&
      'message' in detail &&
      typeof detail.message === 'string'
        ? detail.message
        : `Сервер вернул ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export const marketClient = {
  async priceHistory(id: string) {
    return beltPriceUpdatesResponseSchema.parse(
      await request(
        `/api/market/targets/${encodeURIComponent(id)}/belt-prices`,
      ),
    ).data;
  },
  async savePrices(input: BeltPriceUpdateInput) {
    const response = await request('/api/market/belt-prices', input);
    if (!response || typeof response !== 'object' || !('data' in response))
      throw new Error('Не удалось сохранить цены');
    return beltPriceUpdateSchema.parse(response.data);
  },
  async opportunities(kind: 'observed' | 'demo') {
    return beltOpportunitiesResponseSchema.parse(
      await request(`/api/market/belt-opportunities?kind=${kind}`),
    ).data;
  },
  async load() {
    return marketWorkbenchResponseSchema.parse(await request('/api/market'))
      .data;
  },
  async collection(id: string) {
    return marketCollectionResponseSchema.parse(
      await request(`/api/market/targets/${encodeURIComponent(id)}/collection`),
    ).data;
  },
  async updateCollection(id: string, input: MarketCollectionSettingsInput) {
    return marketCollectionSettingsResponseSchema.parse(
      await request(
        `/api/market/targets/${encodeURIComponent(id)}/collection/settings`,
        input,
        'PUT',
      ),
    ).data;
  },
  async runCollection(id: string) {
    return marketCollectionRunResponseSchema.parse(
      await request(
        `/api/market/targets/${encodeURIComponent(id)}/collection/run`,
        {},
      ),
    ).data;
  },
  async cancelCollection(runId: string) {
    return marketCollectionRunResponseSchema.parse(
      await request(
        `/api/market/collection/runs/${encodeURIComponent(runId)}/cancel`,
        {},
      ),
    ).data;
  },
  async createTarget(input: MarketTargetInput) {
    return marketTargetResponseSchema.parse(
      await request('/api/market/targets', input),
    ).data;
  },
  async importSnapshot(input: MarketSnapshotImport) {
    return marketResearchSnapshotResponseSchema.parse(
      await request('/api/market/snapshots/import', input),
    ).data;
  },
  async analyzeBelt(id: string, version: 1 | 2 | 3 = 1) {
    return beltAnalysisResponseSchema.parse(
      await request(
        `/api/market/snapshots/${encodeURIComponent(id)}/belt-analysis/v${version}`,
      ),
    ).data;
  },
  async getSnapshot(id: string) {
    return marketResearchSnapshotResponseSchema.parse(
      await request(`/api/market/snapshots/${encodeURIComponent(id)}`),
    ).data;
  },
};
