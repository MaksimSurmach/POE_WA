import {
  apiErrorEnvelopeSchema,
  marketAdminSettingsResponseSchema,
  marketAdminSettingsSchema,
  type MarketAdminSettings,
} from '@poe-worksmith/contracts';

export function createHomeSettingsClient(
  token = '',
  fetchImplementation = globalThis.fetch,
) {
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetchImplementation(`/api/admin/market${path}`, {
      method,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = apiErrorEnvelopeSchema.safeParse(payload);
      throw new Error(
        error.success
          ? error.data.error.message
          : `Settings unavailable (${response.status}).`,
      );
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload))
      throw new Error('The settings response is invalid.');
    return marketAdminSettingsResponseSchema.parse(payload.data);
  }
  return {
    settings: () => request('/settings'),
    save: (version: number, settings: Partial<MarketAdminSettings>) =>
      request('/settings', 'PATCH', { version, settings }),
    pause: (paused: boolean, version: number) =>
      request(paused ? '/pause' : '/resume', 'POST', { version }),
  };
}

export function validateQuoteAges(settings: MarketAdminSettings) {
  const parsed = marketAdminSettingsSchema
    .pick({ maximumQuoteAgeMs: true, freshnessWarningMs: true })
    .safeParse({
      maximumQuoteAgeMs: settings.maximumQuoteAgeMs,
      freshnessWarningMs: settings.freshnessWarningMs,
    });
  if (!parsed.success) return 'Enter quote ages between 1 and 120 minutes.';
  if (settings.freshnessWarningMs > settings.maximumQuoteAgeMs)
    return 'Freshness warning must not exceed maximum quote age.';
  if (settings.snapshotReuseTtlMs > settings.maximumQuoteAgeMs)
    return 'Maximum quote age must cover the snapshot reuse interval.';
  return null;
}
