import {
  collectorStatusSchema,
  marketAdminSettingsResponseSchema,
} from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  changeCollectionPause,
  CollectorControls,
  CollectorStatusLine,
} from './CollectorControls.js';

const id = '00000000-0000-4000-8000-000000000001';
// Parsed through the shared contract so stripped fields would fail this test.
const status = (lockHeld: boolean) =>
  collectorStatusSchema.parse({
    collectorState: {
      id: 1,
      lastRunFinishedAt: '2026-11-10T01:00:00.000Z',
      lastRunStatus: 'succeeded',
      lastRunSummary: { kind: 'economy' },
      blockedReason: null,
      sessionCheckedAt: '2026-11-10T01:00:00.000Z',
    },
    latestRequest: {
      id,
      state: 'running',
      summary: { pending: [id, id], succeeded: 3, failed: 1 },
    },
    lockHeld,
    nextDueAt: '2026-11-10T02:00:00.000Z',
  });
const render = (lockHeld: boolean) =>
  renderToStaticMarkup(
    <CollectorStatusLine
      status={status(lockHeld)}
      now={Date.parse('2026-11-10T01:30:00.000Z')}
    />,
  );

it('shows last result, next due and run progress while the collector is connected', () => {
  const html = render(true);
  expect(html).toContain('Collector connected');
  expect(html).toContain('(succeeded)');
  expect(html).toContain('aria-label="Next due"');
  expect(html).toContain('Running 4/6, 1 failed');
  expect(html).toContain('Trade session OK');
  // Callers that do not pass a pause state get the collector line alone.
  expect(html).not.toContain('Collection');
});

it('warns instead of reporting progress when the collector is disconnected', () => {
  const html = render(false);
  expect(html).toContain('recipe-warning');
  expect(html).toContain('Collector disconnected');
  expect(html).toContain('Run waiting for collector');
  expect(html).not.toContain('Running');
  expect(html).not.toContain('Next due');
  expect(html).not.toContain('Updating');
});

it('names the failure code of a failed run', () => {
  const failed = status(true);
  failed.latestRequest = {
    id,
    state: 'failed',
    summary: { error: 'COLLECTOR_NO_ELIGIBLE_TARGETS' },
  };
  expect(
    renderToStaticMarkup(<CollectorStatusLine status={failed} />),
  ).toContain('Run failed: COLLECTOR_NO_ELIGIBLE_TARGETS');
});

const idle = (lockHeld: boolean) => ({
  ...status(lockHeld),
  latestRequest: null,
});
const line = (props: Partial<Parameters<typeof CollectorStatusLine>[0]>) =>
  renderToStaticMarkup(
    <CollectorStatusLine
      status={idle(true)}
      now={Date.parse('2026-11-10T01:30:00.000Z')}
      {...props}
    />,
  );

it('states that collection is active only for a connected, unpaused collector', () => {
  const html = line({ paused: false });
  expect(html).toContain('Collection active');
  expect(html).toContain('Next due');
  const disconnected = line({ paused: false, status: idle(false) });
  expect(disconnected).toContain('Collection not paused');
  expect(disconnected).not.toContain('Collection active');
  expect(disconnected).toContain('Collector disconnected');
});

it('explains a pause and withholds the next due time', () => {
  const html = line({ paused: true });
  expect(html).toContain('Collection paused');
  expect(html).toContain('a capture already in progress finishes');
  expect(html).not.toContain('Next due');
  expect(html).not.toContain('does not start the collector process');
});

it('does not imply that resuming restarts a disconnected collector', () => {
  const html = line({ paused: true, status: idle(false) });
  expect(html).toContain('Collection paused');
  expect(html).toContain('Collector disconnected');
  expect(html).toContain(
    'Resume needs a connected collector; this control does not start the collector process',
  );
});

it('reports an unreadable or stale pause state instead of guessing', () => {
  expect(line({ paused: null })).toContain('Checking collection state');
  expect(line({ paused: null, pauseUnavailable: true })).toContain(
    'Collection state unavailable',
  );
  const stale = line({
    paused: true,
    pauseUnavailable: true,
    pauseNote: 'Could not resume collection: conflict.',
  });
  expect(stale).toContain('last known; could not be re-read');
  expect(stale).toContain('Could not resume collection: conflict.');
});

it('renders native buttons with Run now disabled until both states are known', () => {
  const html = renderToStaticMarkup(<CollectorControls />);
  expect(html).toContain('role="group"');
  expect(html).toMatch(
    /<button[^>]*type="button"[^>]*>Check collection state<\/button>/,
  );
  expect(html).toMatch(
    /<button(?=[^>]*type="button")(?=[^>]*disabled="")[^>]*>Run now/,
  );
});

const adminSettings = {
  automaticRefreshEnabled: true,
  scheduledCollectionEnabled: true,
  manualRefreshEnabled: true,
  refreshCron: '0 * * * *',
  requestTimeoutMs: 10_000,
  collectionConcurrency: 1,
  snapshotReuseTtlMs: 600_000,
  freshnessWarningMs: 3_600_000,
  maximumQuoteAgeMs: 7_200_000,
  rawRetentionHours: 24,
  historyRetentionDays: 14,
};
const settings = (version: number, collectionsPaused: boolean) =>
  marketAdminSettingsResponseSchema.parse({
    version,
    configured: { ...adminSettings, collectionsPaused },
    effective: { ...adminSettings, collectionsPaused },
    restartRequired: false,
    applies: '',
    timezone: 'UTC',
    warnings: [],
  });

describe('changeCollectionPause', () => {
  it('writes with the freshly read version, not the one on screen', async () => {
    const client = {
      settings: vi.fn().mockResolvedValue(settings(7, false)),
      pause: vi.fn().mockResolvedValue(settings(8, true)),
    };
    const result = await changeCollectionPause(client, true);
    expect(client.pause).toHaveBeenCalledExactlyOnceWith(true, 7);
    expect(result.outcome).toBe('changed');
    expect(result.settings?.configured.collectionsPaused).toBe(true);
  });

  it('writes nothing when the server already holds the requested state', async () => {
    const client = {
      settings: vi.fn().mockResolvedValue(settings(4, false)),
      pause: vi.fn(),
    };
    const result = await changeCollectionPause(client, false);
    expect(client.pause).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'already' });
  });

  it('recovers from a version conflict by re-reading, without retrying the resume', async () => {
    // Another tab wrote settings (version 3) between this read and this write.
    const client = {
      settings: vi
        .fn()
        .mockResolvedValueOnce(settings(2, true))
        .mockResolvedValueOnce(settings(3, true)),
      pause: vi
        .fn()
        .mockRejectedValue(
          new Error('The requested data change conflicts with current state.'),
        ),
    };
    const result = await changeCollectionPause(client, false);
    expect(client.pause).toHaveBeenCalledExactlyOnceWith(false, 2);
    expect(client.settings).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('conflicts with current state');
    expect(result.settings?.version).toBe(3);
    expect(result.settings?.configured.collectionsPaused).toBe(true);
    // The operator's next click starts from the re-read version and succeeds.
    client.settings.mockResolvedValueOnce(settings(3, true));
    client.pause.mockResolvedValueOnce(settings(4, false));
    const retried = await changeCollectionPause(client, false);
    expect(client.pause).toHaveBeenLastCalledWith(false, 3);
    expect(retried.outcome).toBe('changed');
  });

  it('reports an unreadable state rather than a guessed one', async () => {
    const unreadable = {
      settings: vi.fn().mockRejectedValue(new Error('offline')),
      pause: vi.fn(),
    };
    expect(await changeCollectionPause(unreadable, true)).toEqual({
      settings: null,
      outcome: 'failed',
      message: 'offline',
    });
    expect(unreadable.pause).not.toHaveBeenCalled();
    const lost = {
      settings: vi
        .fn()
        .mockResolvedValueOnce(settings(1, false))
        .mockRejectedValue(new Error('offline')),
      pause: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    expect(await changeCollectionPause(lost, true)).toEqual({
      settings: null,
      outcome: 'failed',
      message: 'timeout',
    });
  });
});
