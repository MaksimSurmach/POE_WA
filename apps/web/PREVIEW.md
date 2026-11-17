# Worksmith light preview

The preview uses the production light theme, five top navigation sections and the 20 workspace views. The implementation follows the supplied specification; the private reference site required login and visual parity is unverified. The views use the existing React, HeroUI and Vite stack.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @poe-worksmith/web preview:build
```

Open `apps/web/dist-preview/worksmith-heroui.html` directly in a browser. It contains its JavaScript, CSS and fonts; no server or network connection is needed. CI also attaches it as `worksmith-heroui-preview`.

The preview renders the production pages with sample fixtures. Every HTTP write is rejected in memory, and submit/collector buttons are disabled. Prices, history and the Factory ledger are illustrative. Missing probability models and collection evidence remain explicitly unavailable.

The shared UI boundary uses HeroUI buttons, inputs, alerts, chips, cards, disclosure and table surfaces. Native selects retain platform keyboard and FormData behavior while using HeroUI styles. Recipe charts and grouped financial tables retain their domain interactions.

Check the exported file with `pnpm exec playwright test --config playwright.preview.config.ts` after installing Playwright Chromium.

The isolated browser suite runs against the production entrypoint with synthetic, contract-validated API responses: `pnpm exec playwright test --config playwright.light.config.ts`. It does not contact a database. See [coverage and screenshots](../../docs/evidence/worksmith-light/README.md).

Run `pnpm build` before the light suite: it imports the real server item formatter from `apps/server/dist` and compiled contracts. Ordinary runs keep evidence images unchanged; set `CAPTURE_LIGHT_EVIDENCE=1` to refresh the committed synthetic screenshots.
