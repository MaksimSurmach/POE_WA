import { describe, expect, it } from 'vitest';
import { isLocalAdmin, needsAdminAccess } from './adminAccess.js';

describe('local administrative boundary', () => {
  it('accepts direct same-origin loopback and local CLI requests', () => {
    expect(
      isLocalAdmin({ ip: '127.0.0.1', headers: { host: 'localhost:3000' } }),
    ).toBe(true);
    expect(
      isLocalAdmin({
        ip: '::1',
        headers: {
          host: '[::1]:3000',
          origin: 'http://[::1]:3000',
          'sec-fetch-site': 'same-origin',
        },
      }),
    ).toBe(true);
  });
  it.each([
    { ip: '10.1.1.1', headers: { host: 'localhost' } },
    { ip: '127.0.0.1', headers: { host: 'evil.example' } },
    {
      ip: '127.0.0.1',
      headers: { host: 'localhost', origin: 'https://evil.example' },
    },
    { ip: '127.0.0.1', headers: { host: 'localhost', origin: 'null' } },
    {
      ip: '127.0.0.1',
      headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1' },
    },
    {
      ip: '127.0.0.1',
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    },
  ])(
    'rejects public, rebinding, proxy and cross-site access: %j',
    (request) => {
      expect(isLocalAdmin(request)).toBe(false);
    },
  );
  it('protects all market writes and admin reads, leaving public reads available', () => {
    expect(needsAdminAccess('GET', '/api/admin/market/status')).toBe(true);
    expect(needsAdminAccess('POST', '/api/refresh')).toBe(true);
    expect(needsAdminAccess('POST', '/api/market/economy/collect')).toBe(true);
    expect(needsAdminAccess('PATCH', '/api/market/targets/1/collection')).toBe(
      true,
    );
    expect(needsAdminAccess('GET', '/api/catalog')).toBe(false);
  });
});
