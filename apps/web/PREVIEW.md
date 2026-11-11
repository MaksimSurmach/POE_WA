# HeroUI preview

The application uses open-source HeroUI v3 with the dark blue palette and sidebar composition inspired by the [Finances reference](https://heroui.com/en/themes?template=finances). No HeroUI Pro template code is included.

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
