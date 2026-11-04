# Run E0 master packaged smoke locally

Requires Node 22.13–22.x, pnpm 11.8.0, Docker with Compose, and Playwright Chromium installed (`pnpm exec playwright install chromium`).

After a `Master Build` artifact has been downloaded and extracted, run:

```sh
pnpm install --frozen-lockfile
pnpm test:e2e:master -- --manifest artifacts/manifest.json
```

The harness verifies the archive, source and image identities before loading an image or starting containers. It creates a unique labelled Compose project and test database, applies the packaged migrations, syncs the packaged recipe catalog, repeats migration, then starts the packaged API/worker and web images. Results and diagnostics are written to `output/master-e2e/`.

For a branch build, construct the manifest from those exact local image IDs and archives and label the result a **candidate**. A local result does not count as a successful master build or release receipt. The harness never falls back to a developer database.
