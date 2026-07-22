import type { Logger } from 'pino';

export type OperationContext = Readonly<{
  requestId?: string | undefined;
  cycleId?: string | undefined;
  jobId?: string | undefined;
  recipeId?: string | undefined;
  queryHash?: string | undefined;
  provider?: string | undefined;
  leagueId?: string | undefined;
  leagueGggId?: string | undefined;
}>;

export function operationLogger(logger: Logger, context: OperationContext) {
  return logger.child(context);
}
