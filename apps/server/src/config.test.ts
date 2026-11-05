import { describe, expect, it, vi } from 'vitest';

import {
  EnvironmentConfigurationError,
  drizzleConnectionString,
  loadDatabaseConfig,
} from './config.js';

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

  it('does not ignore a test database URL outside test mode', () => {
    expect(() =>
      loadDatabaseConfig({
        APP_ENV: 'development',
        DATABASE_URL:
          'postgresql://postgres:postgres@127.0.0.1:54322/poe_worksmith_dev',
        TEST_DATABASE_URL:
          'postgresql://postgres:postgres@127.0.0.1:54324/poe_worksmith_test',
      }),
    ).toThrow(/TEST_DATABASE_URL: Only allowed when APP_ENV=test/);
  });

  it('normalizes the Drizzle staging URL to one verified SSL mode', () => {
    const config = loadDatabaseConfig({
      APP_ENV: 'staging',
      DATABASE_SSL_MODE: 'require',
      DATABASE_URL:
        'postgresql://postgres:password@db.example/postgres?sslmode=require&channel_binding=require',
    });

    const databaseUrl = new URL(drizzleConnectionString(config));
    expect(databaseUrl.searchParams.getAll('sslmode')).toEqual(['verify-full']);
    expect(databaseUrl.searchParams.get('channel_binding')).toBe('require');
  });

  it('uses the guarded URL in drizzle.config and requires APP_ENV', async () => {
    const previousEnvironment = {
      APP_ENV: process.env.APP_ENV,
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    };
    process.env.APP_ENV = 'staging';
    process.env.DATABASE_SSL_MODE = 'require';
    process.env.DATABASE_URL =
      'postgresql://postgres:password@db.example/postgres?sslmode=require';
    delete process.env.TEST_DATABASE_URL;

    try {
      const config = await import('../drizzle.config.js');
      const databaseUrl = new URL(config.default.dbCredentials.url);
      expect(databaseUrl.searchParams.getAll('sslmode')).toEqual([
        'verify-full',
      ]);

      await vi.resetModules();
      delete process.env.APP_ENV;
      await expect(import('../drizzle.config.js')).rejects.toThrow(/APP_ENV:/);
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await vi.resetModules();
    }
  });

  it('reports missing test configuration without exposing secrets', () => {
    expect(() => loadDatabaseConfig({ APP_ENV: 'test' })).toThrow(
      'TEST_DATABASE_URL: Required when APP_ENV=test',
    );
  });

  it('reports malformed database URLs without echoing credentials', () => {
    let error: unknown;
    try {
      loadDatabaseConfig({
        APP_ENV: 'staging',
        DATABASE_SSL_MODE: 'require',
        DATABASE_URL: 'not-a-url-with-password-secret',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvironmentConfigurationError);
    expect((error as Error).message).toContain(
      'DATABASE_URL: Must be a valid PostgreSQL connection URL',
    );
    expect((error as Error).message).not.toContain('password-secret');
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
    'postgresql://postgres:password@db.example/postgres?sslmode=require&ssl=0',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&ssl=no-verify',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&sslmode=disable',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&sslmode=no-verify',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&sslrootcert=system',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&sslnegotiation=direct',
    'postgresql://postgres:password@db.example/postgres?sslmode=require&uselibpqcompat=true',
    'postgresql://postgres:password@db.example/postgres?ssl%6Dode=require&x=%zz',
    'postgresql://u:%ff@db.example/postgres?sslmode=require',
    'postgresql://u@db.example/postgres?sslmode=require&x=%ff',
    'postgresql://u@%ff/postgres?sslmode=require',
  ])('rejects staging URLs that can override verified TLS', (databaseUrl) => {
    expect(() =>
      loadDatabaseConfig({
        APP_ENV: 'staging',
        DATABASE_SSL_MODE: 'require',
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow(/DATABASE_URL:/);
  });

  it('requires the staging TLS environment flag independently of the URL', () => {
    expect(() =>
      loadDatabaseConfig({
        APP_ENV: 'staging',
        DATABASE_SSL_MODE: 'disable',
        DATABASE_URL:
          'postgresql://postgres:password@db.example/postgres?sslmode=require',
      }),
    ).toThrow(/DATABASE_SSL_MODE: Must be require/);
  });
});
