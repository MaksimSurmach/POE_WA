import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { verifyDatabaseConnection } from './database.js';

describe('database connection diagnostics', () => {
  it('reports the safe target without exposing credentials', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Pool;
    const connectionString =
      'postgresql://worksmith:super-secret@db.example.com:5432/worksmith';

    try {
      await verifyDatabaseConnection(pool, connectionString);
      expect.unreachable('Expected the connection check to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'db.example.com:5432/worksmith',
      );
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});
