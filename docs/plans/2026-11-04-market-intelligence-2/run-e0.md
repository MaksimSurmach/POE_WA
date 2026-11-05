# Run E0 master packaged smoke

Use Node 22, pnpm 11.8.0, Docker Compose, and Playwright Chromium. Run these commands on the Docker host (Contabo in this run):

```sh
pnpm install --frozen-lockfile
pnpm test:e2e:master:self-check
MI2_SHA=$(git rev-parse HEAD)
IMAGE_TAG="local/poe-worksmith:$MI2_SHA"
mkdir -p artifacts
docker build --platform linux/amd64 --target server --tag "$IMAGE_TAG-server" .
docker build --platform linux/amd64 --target web --tag "$IMAGE_TAG-web" .
docker image save "$IMAGE_TAG-server" > artifacts/server.tar
docker image save "$IMAGE_TAG-web" > artifacts/web.tar
IMAGE_TAG="$IMAGE_TAG" node scripts/master-e2e-manifest.mjs artifacts/manifest.json
pnpm test:e2e:master -- --manifest artifacts/manifest.json
```

The same `scripts/master-e2e-manifest.mjs` generates CI and local manifests. Without GitHub's build-run environment it labels the manifest and verdict as `local-candidate`.

For a successful `Master Build` artifact, extract the artifact and run:

```sh
pnpm test:e2e:master -- --manifest artifacts/manifest.json
```

The harness rejects dirty runtime source, verifies the manifest and source lockfile/migration journal, checks archive hashes before image load, then checks image IDs and platform after load. It creates a unique labelled Compose project and test database, applies and repeats packaged migrations, syncs the packaged recipe catalog, starts the packaged API/worker and web images, checks BOOT-01 and ACL-PUBLIC-01, restarts PostgreSQL and the app, then verifies migration state, a durable sentinel row, worker heartbeat and the web-to-API recipe route before removing only its owned resources. Verdict, manifest, Playwright JSON/HTML report, Compose logs and bounded diagnostics are written to `output/master-e2e/`.

A local result is a candidate, not a Master Build/E2E receipt or release acceptance. The harness never falls back to a developer database.
