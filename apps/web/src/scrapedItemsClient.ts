import {
  apiErrorEnvelopeSchema,
  scrapedItemBasesResponseSchema,
  scrapedItemCaptureResponseSchema,
  scrapedItemLinkInputSchema,
  scrapedItemModifiersResponseSchema,
  scrapedItemRejectionSchema,
  scrapedItemRevisionInputSchema,
  scrapedItemSaveInputSchema,
  scrapedItemsResponseSchema,
  scrapedItemTestResponseSchema,
  scrapedItemTestStartResponseSchema,
  scrapedItemWriteResponseSchema,
  type ScrapedItemDiagnostic,
  type ScrapedItemLinkInput,
  type ScrapedItemSaveInput,
} from '@poe-worksmith/contracts';

type Contract<T> = {
  safeParse(value: unknown): { data: T; success: true } | { success: false };
};

/** The server understood the request but it cannot be saved or run. */
export class ScrapedItemsRejected extends Error {
  constructor(readonly diagnostics: readonly ScrapedItemDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'The request was rejected.');
    this.name = 'ScrapedItemsRejected';
  }
}

export class ScrapedItemsError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ScrapedItemsError';
  }
  /** Someone else changed the item since it was loaded. */
  get conflict() {
    return this.code === 'PERSISTENCE_CONFLICT';
  }
}

const root = '/api/settings/scraped-items';

export function createScrapedItemsClient(
  fetchImplementation: typeof fetch = globalThis.fetch,
) {
  async function request<T>(
    path: string,
    contract: Contract<T>,
    {
      method = 'GET',
      body,
      signal,
    }: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<T> {
    const response = await fetchImplementation(`${root}${path}`, {
      method,
      credentials: 'same-origin',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = contract.safeParse(payload);
      if (parsed.success) return parsed.data;
      throw new ScrapedItemsError(
        'The response did not match the shared contract.',
        null,
      );
    }
    const rejection = scrapedItemRejectionSchema.safeParse(payload);
    if (rejection.success)
      throw new ScrapedItemsRejected(rejection.data.data.diagnostics);
    const error = apiErrorEnvelopeSchema.safeParse(payload);
    throw new ScrapedItemsError(
      error.success
        ? error.data.error.message
        : `Scraped items are unavailable (${response.status}).`,
      error.success ? error.data.error.code : null,
    );
  }
  const item = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    list: (signal?: AbortSignal) =>
      request('', scrapedItemsResponseSchema, { signal }),
    listBases: (gameDataVersion: string, signal?: AbortSignal) =>
      request(
        `/bases?${new URLSearchParams({ gameDataVersion })}`,
        scrapedItemBasesResponseSchema,
        { signal },
      ),
    searchModifiers: (
      query: string,
      gameDataVersion: string,
      signal?: AbortSignal,
    ) =>
      request(
        `/modifiers?${new URLSearchParams({ q: query, gameDataVersion })}`,
        scrapedItemModifiersResponseSchema,
        { signal },
      ),
    save: (id: string, input: ScrapedItemSaveInput) =>
      request(item(id), scrapedItemWriteResponseSchema, {
        method: 'PUT',
        body: scrapedItemSaveInputSchema.parse(input),
      }),
    link: (id: string, input: ScrapedItemLinkInput) =>
      request(`${item(id)}/recipes`, scrapedItemWriteResponseSchema, {
        method: 'POST',
        body: scrapedItemLinkInputSchema.parse(input),
      }),
    unlink: (id: string, recipeId: string, expectedRevision: number) =>
      request(
        `${item(id)}/recipes/${encodeURIComponent(recipeId)}?${new URLSearchParams({ expectedRevision: String(expectedRevision) })}`,
        scrapedItemWriteResponseSchema,
        { method: 'DELETE' },
      ),
    startTest: (id: string, expectedRevision: number) =>
      request(`${item(id)}/tests`, scrapedItemTestStartResponseSchema, {
        method: 'POST',
        body: scrapedItemRevisionInputSchema.parse({ expectedRevision }),
      }),
    readTest: (id: string, requestId: string, signal?: AbortSignal) =>
      request(
        `${item(id)}/tests/${encodeURIComponent(requestId)}`,
        scrapedItemTestResponseSchema,
        { signal },
      ),
    readCapture: (id: string, signal?: AbortSignal) =>
      request(`${item(id)}/capture`, scrapedItemCaptureResponseSchema, {
        signal,
      }),
  };
}
export type ScrapedItemsClient = ReturnType<typeof createScrapedItemsClient>;
