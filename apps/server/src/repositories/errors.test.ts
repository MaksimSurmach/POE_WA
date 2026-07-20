import { describe, expect, it } from 'vitest';

import {
  mapRepositoryError,
  RepositoryConflictError,
  RepositoryError,
} from './errors.js';

describe('repository errors', () => {
  it('maps PostgreSQL constraints to a typed conflict', async () => {
    const databaseError = Object.assign(new Error('duplicate secret value'), {
      code: '23505',
    });

    await expect(
      mapRepositoryError('recipes', 'save', async () => {
        throw databaseError;
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      name: 'RepositoryConflictError',
      operation: 'save',
      repository: 'recipes',
    });
  });

  it('maps PostgreSQL constraints wrapped by Drizzle', async () => {
    const databaseError = Object.assign(new Error('duplicate secret value'), {
      code: '23505',
    });

    await expect(
      mapRepositoryError('recipes', 'save', async () => {
        throw new Error('Failed query', { cause: databaseError });
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('maps the running-cycle guard to a domain decision', async () => {
    const databaseError = Object.assign(new Error('duplicate running cycle'), {
      code: '23505',
      constraint: 'refresh_cycles_single_running_uq',
    });

    await expect(
      mapRepositoryError('cycles', 'save', async () => {
        throw databaseError;
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_ALREADY_RUNNING' });
  });

  it('preserves typed infrastructure errors', async () => {
    const conflict = new RepositoryConflictError('cycles', 'publish');

    await expect(
      mapRepositoryError('cycles', 'publish', async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);
  });

  it('maps network failures without leaking their raw message', async () => {
    const databaseError = Object.assign(new Error('password=super-secret'), {
      code: 'ECONNREFUSED',
    });

    try {
      await mapRepositoryError('jobs', 'claimNext', async () => {
        throw databaseError;
      });
      expect.unreachable('Expected repository operation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryError);
      expect((error as RepositoryError).code).toBe('unavailable');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});
