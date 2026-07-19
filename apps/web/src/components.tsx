import type { Price, RecipeEvaluation } from '@poe-worksmith/contracts';
import type { ReactNode } from 'react';

const compactNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
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

export function ProfitBadge({ amount, currency }: Price) {
  const sign = amount > 0 ? '+' : '';

  return (
    <span className={amount > 0 ? 'profit profit--positive' : 'profit'}>
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

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
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
    <span className={`evaluation-status evaluation-status--${status}`}>
      <span aria-hidden="true" />
      {evaluationLabel[status]}
    </span>
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
    <section
      className={`status-panel status-panel--${tone}`}
      role={alert ? 'alert' : 'status'}
    >
      <StatusIcon tone={tone} />
      <div>
        <h2>{title}</h2>
        {children ? <p>{children}</p> : null}
      </div>
    </section>
  );
}

function StatusIcon({ tone }: { tone: StatusTone }) {
  if (tone === 'warning' || tone === 'danger') {
    return (
      <svg
        aria-hidden="true"
        className="status-panel__icon"
        viewBox="0 0 24 24"
      >
        <path d="M12 3 2.8 20h18.4L12 3Z" />
        <path d="M12 9v5m0 3v.1" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="status-panel__icon" viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 1 1-2.35-5.65M20 4v5h-5" />
    </svg>
  );
}
