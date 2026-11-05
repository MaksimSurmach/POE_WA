import { describe, expect, it } from 'vitest';

import {
  EnvironmentConfigurationError,
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
