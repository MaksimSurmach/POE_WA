import { Alert, Chip } from '@heroui/react';
import type { Price, Profit, RecipeEvaluation } from '@poe-worksmith/contracts';
import type { ReactNode } from 'react';

const compactNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

const currencyLabel = {
  chaos: 'c',
  divine: 'div',
} as const;

export function Money({ price }: { price: Price | null }) {
  if (!price) return <span aria-label="Price unavailable">—</span>;

  return (
    <span className="money">
      {compactNumber.format(price.amount)} {currencyLabel[price.currency]}
    </span>
  );
}

export function economicClass(value: number | null) {
  return value === null || value === 0
    ? 'economic-unknown'
    : value > 0
      ? 'economic-positive'
      : 'economic-negative';
}

export function ProfitBadge({ amount, currency }: Profit) {
  const sign = amount > 0 ? '+' : '';

  return (
    <span className={`profit ${economicClass(amount)}`}>
      {sign}
      {compactNumber.format(amount)} {currencyLabel[currency]}
    </span>
  );
}

export function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function ListingAge({ seconds }: { seconds: number }) {
  return (
    <span
      className={
        seconds >= 86400 ? 'listing-age listing-age--old' : 'listing-age'
      }
    >
      {formatAge(seconds)}
    </span>
  );
}

export function FreshnessIndicator({ ageSeconds }: { ageSeconds: number }) {
  const isStale = ageSeconds >= 3600;

  return (
    <span className={isStale ? 'freshness freshness--stale' : 'freshness'}>
      <span aria-hidden="true" className="freshness__dot" />
      {formatAge(ageSeconds)}
    </span>
  );
}

const evaluationLabel: Record<RecipeEvaluation['status'], string> = {
  error: 'Error',
  loading: 'Loading',
  partial: 'Partial',
  stale: 'Stale',
  success: 'Ready',
};

export function EvaluationStatus({
  status,
}: {
  status: RecipeEvaluation['status'];
}) {
  return (
    <Chip
      className={`evaluation-status evaluation-status--${status}`}
      color={
        status === 'success'
          ? 'success'
          : status === 'error'
            ? 'danger'
            : status === 'loading'
              ? 'accent'
              : 'warning'
      }
      size="sm"
      variant="soft"
    >
      <Chip.Label>{evaluationLabel[status]}</Chip.Label>
    </Chip>
  );
}

type StatusTone = 'info' | 'success' | 'warning' | 'danger';

export function StatusPanel({
  children,
  title,
  tone,
}: {
  children?: ReactNode;
  title: string;
  tone: StatusTone;
}) {
  const alert = tone === 'danger';

  return (
    <Alert
      className={`status-panel status-panel--${tone}`}
      status={tone === 'info' ? 'accent' : tone}
      role={alert ? 'alert' : 'status'}
    >
      <Alert.Indicator />
      <Alert.Content>
        <h2 className="alert__title">{title}</h2>
        {children ? <div className="alert__description">{children}</div> : null}
      </Alert.Content>
    </Alert>
  );
}
