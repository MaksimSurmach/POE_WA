import { z } from 'zod';

type TestState = 'queued' | 'running' | 'blocked' | 'failed' | 'succeeded';

// Collector outcomes that mean the search could not be attempted or was refused,
// as opposed to an attempt that ran and came back wrong.
const blockedReasons = new Set([
  'COLLECTIONS_PAUSED',
  'COLLECTOR_NO_ELIGIBLE_TARGETS',
  'MARKET_ACCESS_BLOCKED',
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_CHALLENGE',
  'SCHEDULE_UNAVAILABLE',
  'TRADE_ACCESS_BLOCKED',
  'TRADE_SESSION_DECRYPT_FAILED',
  'TRADE_SESSION_KEY_INVALID',
]);

const requestSummary = z.object({
  error: z.string().optional(),
  results: z
    .array(
      z.object({
        captureId: z.string().nullable(),
        reason: z.string().nullable(),
        status: z.enum(['succeeded', 'retry', 'blocked', 'unavailable']),
      }),
    )
    .optional(),
});

/**
 * Reads the collector's own record of a run request. A test is only
 * "succeeded" when the collector says its search succeeded and names a capture.
 */
export function classifyScrapedItemTest(request: {
  state: string;
  summary: Record<string, unknown> | null;
}): { state: TestState; reason: string | null; captureId: string | null } {
  if (request.state === 'queued')
    return { state: 'queued', reason: null, captureId: null };
  if (request.state === 'running')
    return { state: 'running', reason: null, captureId: null };
  const summary = requestSummary.safeParse(request.summary ?? {});
  const results = summary.success ? (summary.data.results ?? []) : [];
  const failure = results.find(({ status }) => status !== 'succeeded');
  const success = results.find(({ status }) => status === 'succeeded');
  if (request.state === 'done' && success?.captureId)
    return { state: 'succeeded', reason: null, captureId: success.captureId };
  const reason =
    failure?.reason ??
    (summary.success ? summary.data.error : undefined) ??
    'COLLECTOR_REQUEST_RESULT_MISSING';
  return {
    state:
      failure?.status === 'blocked' ||
      failure?.status === 'unavailable' ||
      blockedReasons.has(reason)
        ? 'blocked'
        : 'failed',
    reason,
    captureId: null,
  };
}
