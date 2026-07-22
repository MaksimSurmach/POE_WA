import type { RefreshProgressResponse } from '@poe-worksmith/contracts';
import { useEffect, useState } from 'react';

import { createApiClient } from './apiClient.js';

const apiClient = createApiClient();

export function formatRefreshFreshness(
  freshness: RefreshProgressResponse['data'],
  now: number,
) {
  const relative = (timestamp: string) => {
    const seconds = Math.max(
      0,
      Math.floor((now - Date.parse(timestamp)) / 1000),
    );
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
  };
  const absolute = (timestamp: string) =>
    `${new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
    }).format(new Date(timestamp))} (${freshness.schedule.timezone})`;
  const next = absolute(freshness.schedule.nextScheduledAt);
  switch (freshness.state) {
    case 'never-published':
      return 'Awaiting first market publication';
    case 'scheduled':
      return `Next refresh ${relative(freshness.schedule.nextScheduledAt)}; ${next}`;
    case 'queued':
      return `Refresh queued; next scheduled ${next}`;
    case 'running': {
      const cycle = freshness.active;
      return cycle
        ? `Refresh in progress with ${cycle.completedQueries + cycle.completedRecipes}/${cycle.totalQueries + cycle.totalRecipes} progress`
        : 'Refresh in progress';
    }
    case 'failed':
      return `Last refresh failed ${freshness.lastAttempt ? relative(freshness.lastAttempt.requestedAt) : 'recently'};${freshness.lastSuccessful ? ` previous snapshot ${relative(freshness.lastSuccessful.publishedAt)};` : ''} next schedule ${next}`;
    case 'published':
      return freshness.lastSuccessful
        ? `Last snapshot ${relative(freshness.lastSuccessful.publishedAt)}; next refresh ${relative(freshness.schedule.nextScheduledAt)}`
        : `Next refresh ${relative(freshness.schedule.nextScheduledAt)}`;
  }
}

export function RefreshFreshness() {
  const [response, setResponse] = useState<RefreshProgressResponse | null>(
    null,
  );
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    apiClient
      .getRefreshFreshness()
      .then((value) => {
        if (!active) return;
        const clientNow = Date.now();
        setOffset(Date.parse(value.data.serverTime) - clientNow);
        setNow(clientNow);
        setResponse(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!response) return null;
  return (
    <p data-refresh-state={response.data.state}>
      {formatRefreshFreshness(response.data, now + offset)}
    </p>
  );
}
