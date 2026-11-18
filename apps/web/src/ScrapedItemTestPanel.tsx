import type {
  ScrapedCaptureDiagnostics,
  ScrapedItem,
  ScrapedItemTest,
} from '@poe-worksmith/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatTimestamp } from './dateTime.js';
import { ScrapedItemCaptureReport } from './ScrapedItemCaptureReport.js';
import {
  ScrapedItemsError,
  type ScrapedItemsClient,
} from './scrapedItemsClient.js';
import {
  reasonLabel,
  testIsActive,
  testStateLabel,
} from './scrapedItemsModel.js';
import { Button } from './ui.js';

const pollMs = 3_000;
const storageKey = (itemId: string) => `worksmith:scraped-test:${itemId}`;

function remembered(itemId: string) {
  try {
    return sessionStorage.getItem(storageKey(itemId));
  } catch {
    return null;
  }
}
function remember(itemId: string, requestId: string | null) {
  try {
    if (requestId) sessionStorage.setItem(storageKey(itemId), requestId);
    else sessionStorage.removeItem(storageKey(itemId));
  } catch {
    // Remembering the last test is a convenience only.
  }
}

/**
 * Runs this one search through the collector and reports what that request
 * did. It is never a recipe or full-catalog run: those refresh other searches.
 */
export function ScrapedItemTestPanel({
  client,
  dirty,
  item,
  paused,
  onFinished,
}: {
  client: Pick<ScrapedItemsClient, 'startTest' | 'readTest' | 'readCapture'>;
  dirty: boolean;
  item: ScrapedItem;
  paused: boolean;
  /** Called once when a test started in this view reaches an end state. */
  onFinished?: () => void;
}) {
  const [requestId, setRequestId] = useState<string | null>(() =>
    remembered(item.id),
  );
  const [test, setTest] = useState<ScrapedItemTest | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState('');
  const captureScope = `${item.id}:${item.query.key}:${item.latestCapture?.captureId ?? ''}`;
  const currentCaptureScope = useRef(captureScope);
  currentCaptureScope.current = captureScope;
  const [latest, setLatest] = useState<{
    scope: string;
    capture: ScrapedCaptureDiagnostics | null;
  }>();
  const [checkingScope, setCheckingScope] = useState<string | null>(null);
  const pendingCompletion = useRef<string | null>(null);
  // Read through a ref so a new callback each render never restarts polling.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    if (!requestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = (
          await client.readTest(item.id, requestId, controller.signal)
        ).data;
        if (controller.signal.aborted) return;
        setTest(next);
        setMessage('');
        if (testIsActive(next.state)) {
          pendingCompletion.current = requestId;
          timer = setTimeout(load, pollMs);
        } else if (pendingCompletion.current === requestId) {
          pendingCompletion.current = null;
          finished.current?.();
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          cause instanceof ScrapedItemsError &&
          cause.code === 'PERSISTENCE_NOT_FOUND'
        ) {
          remember(item.id, null);
          setRequestId(null);
          setTest(null);
        } else {
          timer = setTimeout(load, pollMs);
        }
        setMessage(
          cause instanceof Error
            ? `The last test could not be read: ${cause.message}`
            : 'The last test could not be read.',
        );
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, item.id, item.revision, item.query.key, requestId]);

  async function start() {
    setStarting(true);
    setMessage('');
    try {
      const started = await client.startTest(item.id, item.revision);
      remember(item.id, started.data.requestId);
      pendingCompletion.current = started.data.requestId;
      setTest(null);
      setRequestId(started.data.requestId);
      setMessage('Test queued. The collector runs it within its rate limits.');
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : 'The test could not be started.',
      );
    } finally {
      setStarting(false);
    }
  }

  const checkLatest = useCallback(async () => {
    setCheckingScope(captureScope);
    try {
      const response = await client.readCapture(item.id);
      if (currentCaptureScope.current !== captureScope) return;
      setLatest({ scope: captureScope, capture: response.data });
    } catch (cause) {
      if (currentCaptureScope.current !== captureScope) return;
      setMessage(
        cause instanceof Error
          ? cause.message
          : 'The capture could not be read.',
      );
    } finally {
      if (currentCaptureScope.current === captureScope) setCheckingScope(null);
    }
  }, [client, item.id, captureScope]);

  const checking = checkingScope === captureScope;
  const stale =
    test &&
    (test.stale ||
      test.itemRevision !== item.revision ||
      test.scheduleKey !== item.query.key);
  const active = test ? testIsActive(test.state) : requestId !== null && !test;
  const blockedReason =
    item.query.status === 'blocked'
      ? 'This search does not compile, so it cannot be tested.'
      : paused
        ? 'Collection is paused. Resume it in Settings → Collection first.'
        : dirty
          ? 'Save your changes first. A test always runs the saved revision.'
          : '';
  return (
    <section className="scraped-panel" aria-labelledby="scraped-test-heading">
      <h3 id="scraped-test-heading">Test this search</h3>
      <p className="scraped-hint">
        Queues only this search with the collector. It keeps the
        collector&apos;s rate limits, session and challenge handling, and
        fetches nothing by itself.
      </p>
      <div className="scraped-actions">
        <Button
          type="button"
          variant="primary"
          liveAction
          disabled={starting || active || blockedReason !== ''}
          onClick={() => void start()}
        >
          {active ? 'Test in progress…' : 'Run test'}
        </Button>
        {blockedReason ? (
          <span className="scraped-hint">{blockedReason}</span>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="scraped-message">
        {message}
      </p>
      {test ? (
        <div className="scraped-result" data-state={test.state}>
          <p>
            <strong>{testStateLabel[test.state]}</strong>
            {test.reason ? ` — ${reasonLabel(test.reason)}` : ''}
          </p>
          <dl className="scraped-facts">
            <div className="scraped-fact">
              <dt>Request</dt>
              <dd>
                <code>{test.requestId}</code>
              </dd>
            </div>
            <div className="scraped-fact">
              <dt>Item revision</dt>
              <dd>{test.itemRevision}</dd>
            </div>
            <div className="scraped-fact">
              <dt>Requested</dt>
              <dd>{formatTimestamp(test.requestedAt)}</dd>
            </div>
            {test.finishedAt ? (
              <div className="scraped-fact">
                <dt>Finished</dt>
                <dd>{formatTimestamp(test.finishedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {stale ? (
            <p className="scraped-note" role="note">
              This result describes a previous search configuration.
            </p>
          ) : null}
          {test.capture ? (
            <ScrapedItemCaptureReport capture={test.capture} />
          ) : null}
        </div>
      ) : null}
      <div className="scraped-latest">
        <h4>Latest capture of the current search</h4>
        {item.latestCapture ? (
          <p className="scraped-hint">
            Captured {formatTimestamp(item.latestCapture.capturedAt)}.
          </p>
        ) : (
          <p className="scraped-hint">
            No capture exists for this exact search yet.
          </p>
        )}
        <Button
          type="button"
          disabled={checking || !item.latestCapture}
          onClick={() => void checkLatest()}
        >
          {checking ? 'Checking…' : 'Check latest capture'}
        </Button>
        {latest?.scope === captureScope && latest.capture ? (
          <ScrapedItemCaptureReport capture={latest.capture} />
        ) : null}
      </div>
    </section>
  );
}
