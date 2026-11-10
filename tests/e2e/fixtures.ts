import { test as base, expect, type APIRequestContext } from '@playwright/test';

export const test = base.extend({});
export { expect };

export const operatorToken = 'worksmith-e2e-operator-only';

export async function waitForCollector(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/collector/status', {
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        return response.ok() && (await response.json()).lockHeld;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}
