export type RepositoryErrorCode =
  'conflict' | 'failure' | 'not_found' | 'unavailable';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly operation: string;
  readonly repository: string;

  constructor(options: {
    cause?: unknown;
    code?: RepositoryErrorCode;
    message: string;
    operation: string;
    repository: string;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'RepositoryError';
    this.code = options.code ?? 'failure';
    this.operation = options.operation;
    this.repository = options.repository;
  }
}

export class RepositoryConflictError extends RepositoryError {
  constructor(repository: string, operation: string, cause?: unknown) {
    super({
      cause,
      code: 'conflict',
      message: `${repository}.${operation} violated a persistence constraint`,
      operation,
      repository,
    });
    this.name = 'RepositoryConflictError';
  }
}

export class RepositoryNotFoundError extends RepositoryError {
  constructor(repository: string, operation: string) {
    super({
      code: 'not_found',
      message: `${repository}.${operation} could not find the requested record`,
      operation,
      repository,
    });
    this.name = 'RepositoryNotFoundError';
  }
}

export async function mapRepositoryError<T>(
  repository: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RepositoryError) throw error;

    const databaseCode =
      typeof error === 'object' && error && 'code' in error
        ? String(error.code)
        : null;

    if (databaseCode && ['23503', '23505', '23514'].includes(databaseCode)) {
      throw new RepositoryConflictError(repository, operation, error);
    }

    throw new RepositoryError({
      cause: error,
      code:
        databaseCode &&
        ['ECONNREFUSED', 'ENETUNREACH', '57P01'].includes(databaseCode)
          ? 'unavailable'
          : 'failure',
      message: `${repository}.${operation} failed`,
      operation,
      repository,
    });
  }
}
