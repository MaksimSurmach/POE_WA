import {
  beltAnalysisResponseSchema,
  marketWorkbenchResponseSchema,
  marketTargetResponseSchema,
  marketResearchSnapshotResponseSchema,
  type MarketTargetInput,
  type MarketSnapshotImport,
} from '@poe-worksmith/contracts';

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
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
  async load() {
    return marketWorkbenchResponseSchema.parse(await request('/api/market'))
      .data;
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
  async analyzeBelt(id: string) {
    return beltAnalysisResponseSchema.parse(
      await request(
        `/api/market/snapshots/${encodeURIComponent(id)}/belt-analysis/v1`,
      ),
    ).data;
  },
  async getSnapshot(id: string) {
    return marketResearchSnapshotResponseSchema.parse(
      await request(`/api/market/snapshots/${encodeURIComponent(id)}`),
    ).data;
  },
};
