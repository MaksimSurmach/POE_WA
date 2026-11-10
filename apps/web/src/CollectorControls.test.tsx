import { collectorStatusSchema } from '@poe-worksmith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { CollectorStatusLine } from './CollectorControls.js';

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
