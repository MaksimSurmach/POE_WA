export const domainErrorCategories = [
  'calculation',
  'internal',
  'market',
  'persistence',
  'publication',
  'queue',
  'recipe',
  'refresh',
  'snapshot',
] as const;

export const errorDispositions = [
  'degraded',
  'permanent',
  'retryable',
] as const;

export type DomainErrorCategory = (typeof domainErrorCategories)[number];
export type ErrorDisposition = (typeof errorDispositions)[number];

type ErrorDefinition = {
  category: DomainErrorCategory;
  disposition: ErrorDisposition;
  publicMessage: string;
};

export const domainErrorDefinitions = {
  CALCULATION_FAILED: {
    category: 'calculation',
    disposition: 'permanent',
    publicMessage: 'The recipe economics could not be calculated.',
  },
  CALCULATION_INPUT_INVALID: {
    category: 'calculation',
    disposition: 'permanent',
    publicMessage: 'The recipe has invalid calculation inputs.',
  },
  INSUFFICIENT_LISTINGS: {
    category: 'calculation',
    disposition: 'degraded',
    publicMessage: 'There are not enough listings for a reliable estimate.',
  },
  INTERNAL_ERROR: {
    category: 'internal',
    disposition: 'retryable',
    publicMessage: 'The request could not be completed.',
  },
  JOB_ATTEMPTS_EXHAUSTED: {
    category: 'queue',
    disposition: 'permanent',
    publicMessage: 'The background job could not be completed.',
  },
  JOB_CONFLICT: {
    category: 'queue',
    disposition: 'retryable',
    publicMessage: 'The background job is already being processed.',
  },
  JOB_PAYLOAD_INVALID: {
    category: 'queue',
    disposition: 'permanent',
    publicMessage: 'The background job is invalid.',
  },
  JOB_TRANSITION_INVALID: {
    category: 'queue',
    disposition: 'permanent',
    publicMessage: 'The background job cannot enter the requested state.',
  },
  MARKET_QUERY_INVALID: {
    category: 'market',
    disposition: 'permanent',
    publicMessage: 'The market query is invalid.',
  },
  MATERIAL_PRICE_MISSING: {
    category: 'market',
    disposition: 'degraded',
    publicMessage: 'The material has no current market price.',
  },
  NO_LISTINGS: {
    category: 'market',
    disposition: 'degraded',
    publicMessage: 'No matching market listings are available.',
  },
  PERSISTENCE_CONFLICT: {
    category: 'persistence',
    disposition: 'permanent',
    publicMessage: 'The requested data change conflicts with current state.',
  },
  PERSISTENCE_FAILED: {
    category: 'persistence',
    disposition: 'retryable',
    publicMessage: 'The requested data operation failed.',
  },
  PERSISTENCE_NOT_FOUND: {
    category: 'persistence',
    disposition: 'permanent',
    publicMessage: 'The requested record does not exist.',
  },
  PERSISTENCE_UNAVAILABLE: {
    category: 'persistence',
    disposition: 'retryable',
    publicMessage: 'The data store is temporarily unavailable.',
  },
  PROVIDER_AUTH_FAILED: {
    category: 'market',
    disposition: 'permanent',
    publicMessage: 'The market provider rejected authentication.',
  },
  PROVIDER_RATE_LIMITED: {
    category: 'market',
    disposition: 'retryable',
    publicMessage: 'The market provider rate limit was reached.',
  },
  PROVIDER_RESPONSE_INVALID: {
    category: 'market',
    disposition: 'degraded',
    publicMessage: 'The market provider returned an invalid response.',
  },
  PROVIDER_UNAVAILABLE: {
    category: 'market',
    disposition: 'retryable',
    publicMessage: 'The market provider is temporarily unavailable.',
  },
  PUBLICATION_BELOW_THRESHOLD: {
    category: 'publication',
    disposition: 'degraded',
    publicMessage: 'The refresh did not meet the publication threshold.',
  },
  PUBLICATION_CONFLICT: {
    category: 'publication',
    disposition: 'retryable',
    publicMessage: 'Another catalog publication is in progress.',
  },
  PUBLICATION_FAILED: {
    category: 'publication',
    disposition: 'retryable',
    publicMessage: 'The refreshed catalog could not be published.',
  },
  PUBLICATION_INCOMPLETE: {
    category: 'publication',
    disposition: 'permanent',
    publicMessage: 'The refresh must finish before it can be published.',
  },
  PUBLICATION_TRANSITION_INVALID: {
    category: 'publication',
    disposition: 'permanent',
    publicMessage: 'The catalog cannot be published from its current state.',
  },
  QUEUE_UNAVAILABLE: {
    category: 'queue',
    disposition: 'retryable',
    publicMessage: 'The background queue is temporarily unavailable.',
  },
  RECIPE_ASSET_INVALID: {
    category: 'recipe',
    disposition: 'permanent',
    publicMessage: 'A recipe asset is missing or invalid.',
  },
  RECIPE_DUPLICATE_ID: {
    category: 'recipe',
    disposition: 'permanent',
    publicMessage: 'The recipe identifier is duplicated.',
  },
  RECIPE_INVALID: {
    category: 'recipe',
    disposition: 'permanent',
    publicMessage: 'The recipe content is invalid.',
  },
  RECIPE_SOURCE_UNREADABLE: {
    category: 'recipe',
    disposition: 'permanent',
    publicMessage: 'The recipe source could not be read.',
  },
  RECIPE_SYNC_FAILED: {
    category: 'recipe',
    disposition: 'retryable',
    publicMessage: 'The recipe catalog could not be synchronized.',
  },
  ROUTE_NOT_FOUND: {
    category: 'internal',
    disposition: 'permanent',
    publicMessage: 'The requested API route does not exist.',
  },
  REFRESH_ALREADY_RUNNING: {
    category: 'refresh',
    disposition: 'retryable',
    publicMessage: 'A catalog refresh is already running.',
  },
  REFRESH_FAILED: {
    category: 'refresh',
    disposition: 'retryable',
    publicMessage: 'The catalog refresh failed.',
  },
  REFRESH_INCOMPLETE: {
    category: 'refresh',
    disposition: 'degraded',
    publicMessage: 'The catalog refresh completed with missing results.',
  },
  REFRESH_STATE_INVALID: {
    category: 'refresh',
    disposition: 'permanent',
    publicMessage: 'The refresh state is internally inconsistent.',
  },
  REFRESH_TRANSITION_INVALID: {
    category: 'refresh',
    disposition: 'permanent',
    publicMessage: 'The refresh cannot enter the requested state.',
  },
  SNAPSHOT_EXPIRED: {
    category: 'snapshot',
    disposition: 'degraded',
    publicMessage: 'Only stale market data is available.',
  },
  SNAPSHOT_INVALID: {
    category: 'snapshot',
    disposition: 'permanent',
    publicMessage: 'The market snapshot is invalid.',
  },
  SNAPSHOT_MISSING: {
    category: 'snapshot',
    disposition: 'degraded',
    publicMessage: 'No market snapshot is available.',
  },
  SNAPSHOT_WRITE_FAILED: {
    category: 'snapshot',
    disposition: 'retryable',
    publicMessage: 'The market snapshot could not be stored.',
  },
  UNSUPPORTED_CURRENCY: {
    category: 'calculation',
    disposition: 'permanent',
    publicMessage: 'The listing uses an unsupported currency.',
  },
  UNKNOWN_MATERIAL: {
    category: 'market',
    disposition: 'permanent',
    publicMessage: 'The material key is not configured.',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type DomainErrorCode = keyof typeof domainErrorDefinitions;

export const domainErrorCodes = Object.keys(domainErrorDefinitions) as [
  DomainErrorCode,
  ...DomainErrorCode[],
];

type DefinitionFor<C extends DomainErrorCode> =
  (typeof domainErrorDefinitions)[C];

export type DomainErrorDescriptor = {
  [C in DomainErrorCode]: {
    category: DefinitionFor<C>['category'];
    code: C;
    disposition: DefinitionFor<C>['disposition'];
    publicMessage: DefinitionFor<C>['publicMessage'];
  };
}[DomainErrorCode];

export type PublicDomainError = {
  category: DomainErrorCategory;
  code: DomainErrorCode;
  disposition: ErrorDisposition;
  message: string;
  retryable: boolean;
};

export class DomainError<
  C extends DomainErrorCode = DomainErrorCode,
> extends Error {
  readonly category: DefinitionFor<C>['category'];
  readonly code: C;
  readonly disposition: DefinitionFor<C>['disposition'];

  constructor(code: C, options: { cause?: unknown } = {}) {
    const definition = domainErrorDefinitions[code];
    super(definition.publicMessage, { cause: options.cause });
    this.name = 'DomainError';
    this.category = definition.category;
    this.code = code;
    this.disposition = definition.disposition;
  }

  toJSON(): PublicDomainError {
    return serializeDomainError(this);
  }
}

export type AnyDomainError = {
  [C in DomainErrorCode]: DomainError<C>;
}[DomainErrorCode];

export type Result<T, E = AnyDomainError> =
  { ok: false; error: E } | { ok: true; value: T };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<C extends DomainErrorCode>(
  error: DomainError<C>,
): Result<never, DomainError<C>> {
  return { error, ok: false };
}

export function isRetryable(error: AnyDomainError) {
  return error.disposition === 'retryable';
}

export function allowsDegradedResult(error: AnyDomainError) {
  return error.disposition === 'degraded';
}

export function serializeDomainError(error: DomainError): PublicDomainError {
  return {
    category: error.category,
    code: error.code,
    disposition: error.disposition,
    message: error.message,
    retryable: error.disposition === 'retryable',
  };
}
