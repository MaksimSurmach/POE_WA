import { describe, expect, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';

describe('database environment configuration', () => {
  it('loads development configuration with bounded pool defaults', () => {
    const config = loadDatabaseConfig({
      APP_ENV: 'development',
      DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
    });

    expect(config.environment).toBe('development');
    expect(config.maxConnections).toBe(6);
    expect(config.ssl).toBe(false);
  });

  it('uses only the isolated test database in test mode', () => {
    const config = loadDatabaseConfig({
      APP_ENV: 'test',
      DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
      TEST_DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:54324/poe_worksmith_test',
    });

    expect(config.connectionString).toContain('poe_worksmith_test');
  });

  it('reports missing test configuration without exposing secrets', () => {
    expect(() => loadDatabaseConfig({ APP_ENV: 'test' })).toThrow(
      'TEST_DATABASE_URL: Required when APP_ENV=test',
    );
  });

  it('requires TLS for staging connections', () => {
    const databaseUrl =
      'postgresql://postgres.example:password@pooler.supabase.com:5432/postgres?sslmode=require';
    const config = loadDatabaseConfig({
      APP_ENV: 'staging',
      DATABASE_SSL_MODE: 'require',
      DATABASE_URL: databaseUrl,
    });

    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode=');
  });

  it.each([
    'postgresql://postgres:password@db.example/postgres?sslmode=disable',
    'postgresql://postgres:password@db.example/postgres?sslmode=no-verify',
    'postgresql://postgres:password@db.example/postgres',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&sslrootcert=system',
  ])('rejects staging URLs that can override verified TLS', (databaseUrl) => {
    expect(() =>
      loadDatabaseConfig({
        APP_ENV: 'staging',
        DATABASE_SSL_MODE: 'require',
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow(/DATABASE_URL:/);
  });
});
