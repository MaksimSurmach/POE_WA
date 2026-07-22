import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { operationLogger } from './operationContext.js';

describe('operationLogger', () => {
  it('adds only explicit operation context', () => {
    const records: string[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (value) => records.push(value) },
    );
    operationLogger(logger, { cycleId: 'cycle-1', leagueId: 'league-1' }).info(
      'refresh.started',
    );
    expect(JSON.parse(records[0]!)).toMatchObject({
      cycleId: 'cycle-1',
      leagueId: 'league-1',
      msg: 'refresh.started',
    });
  });
});
