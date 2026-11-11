import { test as base, expect, type APIRequestContext } from '@playwright/test';

export const test = base.extend({});
export { expect };

export async function waitForCollector(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/collector/status');
        return response.ok() && (await response.json()).lockHeld;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}
