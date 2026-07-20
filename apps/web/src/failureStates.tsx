import {
  type DomainErrorCode,
  domainErrorCodes,
  domainErrorDefinitions,
  type RecipeEvaluation,
} from '@poe-worksmith/contracts';

import { StatusPanel } from './components.js';

const successfulAtFormatter = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
  timeZone: 'UTC',
  timeZoneName: 'short',
  year: 'numeric',
});

type FailureTone = 'info' | 'warning' | 'danger';
type FailureScope = 'catalog' | 'recipe';

export function FailureStatePanel({
  errorCode,
  lastSuccessfulAt,
  scope,
}: {
  errorCode: DomainErrorCode;
  lastSuccessfulAt: string | null;
  scope: FailureScope;
}) {
  const presentation = failurePresentation(errorCode, scope);
  const definition = domainErrorDefinitions[errorCode];

  return (
    <div className="failure-state" data-error-code={errorCode}>
      <StatusPanel tone={presentation.tone} title={presentation.title}>
        {definition.publicMessage} {presentation.recovery}
        {lastSuccessfulAt ? (
          <>
            {' '}
            <span className="failure-state__timestamp">
              Last successful evaluation:{' '}
              <time dateTime={lastSuccessfulAt}>
                {successfulAtFormatter.format(new Date(lastSuccessfulAt))}
              </time>
              .
            </span>
          </>
        ) : null}
      </StatusPanel>
    </div>
  );
}

export function RecipeStatePanel({
  evaluation,
}: {
  evaluation: RecipeEvaluation;
}) {
  if (evaluation.status === 'success') return null;
  if (evaluation.status === 'loading' || evaluation.errorCode === null) {
    return (
      <StatusPanel tone="info" title="No market data yet">
        This recipe is queued for its first market evaluation. The page will
        update after a successful refresh.
      </StatusPanel>
    );
  }

  return (
    <FailureStatePanel
      errorCode={evaluation.errorCode}
      lastSuccessfulAt={evaluation.lastSuccessfulAt}
      scope="recipe"
    />
  );
}

export const knownFailureCodes = domainErrorCodes;

function failurePresentation(
  code: DomainErrorCode,
  scope: FailureScope,
): { recovery: string; title: string; tone: FailureTone } {
  const definition = domainErrorDefinitions[code];

  if (code === 'NO_LISTINGS') {
    return {
      recovery:
        'Craft cost remains visible; sale price and profit are withheld.',
      title: 'No market listings yet',
      tone: 'warning',
    };
  }
  if (code === 'SNAPSHOT_MISSING') {
    return {
      recovery:
        'A refresh will fill this panel when the first snapshot arrives.',
      title: 'No market data yet',
      tone: 'info',
    };
  }
  if (code === 'PROVIDER_RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE') {
    return {
      recovery:
        'Automatic refresh will retry; existing results remain visible.',
      title: 'Market provider temporarily unavailable',
      tone: 'warning',
    };
  }
  if (definition.category === 'recipe' || code === 'MARKET_QUERY_INVALID') {
    return {
      recovery: 'Correct the recipe source and run catalog sync again.',
      title: 'Recipe configuration is invalid',
      tone: 'danger',
    };
  }
  if (definition.category === 'calculation') {
    return {
      recovery: 'Other recipe guidance and catalog results remain available.',
      title: 'Calculation unavailable',
      tone: 'danger',
    };
  }
  if (definition.disposition === 'degraded') {
    return {
      recovery: 'Usable values remain visible while the next refresh runs.',
      title: 'Limited market data',
      tone: 'warning',
    };
  }
  if (definition.disposition === 'retryable') {
    return {
      recovery: 'Automatic recovery will retry this operation.',
      title: 'Temporary refresh problem',
      tone: 'warning',
    };
  }
  return {
    recovery:
      scope === 'recipe'
        ? 'Other catalog recipes remain available.'
        : 'The last published catalog remains available.',
    title:
      scope === 'recipe'
        ? 'Recipe result unavailable'
        : 'Catalog update blocked',
    tone: 'danger',
  };
}
