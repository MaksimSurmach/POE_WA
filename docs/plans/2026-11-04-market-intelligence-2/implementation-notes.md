# E0 implementation notes

## Run record

- Scope: E0. Starting SHA: `0421e4729ca43eb3f66e24bfc38a4e88309cccf8`.
- Branch: `codex/mi2-e0`; reviewed candidate: `e0d41a5c6b8bf783a7fc13146c48edc7606bdf4e` (9 local commits; PR #34 open as draft).
- Builds and runtime validation ran on Contabo via `ssh contabo-main-443`; local machine was used for code and docs only.
- Implemented exact-build artifact workflows, guarded manifest/image validation, isolated Compose smoke environment, packaged boot test, workflow action SHA pins, and launch instructions.

## Validation

- Contabo: frozen pnpm install, lint, typecheck, Compose config, Linux/amd64 Docker builds, harness self-check and packaged E2E passed.
- Smoke applied migrations twice, seeded 28 recipes, confirmed a fresh catalog-worker heartbeat, checked API/recipe reads, denied admin mutation through packaged nginx with `401 OPERATOR_AUTH_REQUIRED` and no DB side effects, loaded the recipe page and successful JS/CSS assets, restarted the app and confirmed the recipe count remained unchanged, then removed only its labelled containers, networks and volume.
- Final verdict: **PASS candidate** for `e0d41a5c6b8bf783a7fc13146c48edc7606bdf4e`. Server image `sha256:caf3a4d3c89e0fc1a331d5c2d17daeb55efe3b9f907b8d4252f100d9c412beaf`; web image `sha256:395f3782e5f0639d2cdee3af26c15125dfc926f6cbccd7312bafe5f246cdc739`.
- Report and manifest: `output/master-e2e/`.
- GitHub Actions `quality` passed on the PR. Master Build/Master E2E were not run because they trigger on master/dispatch. This Contabo candidate result is not a master receipt or release acceptance. E1 was not started.

## Constraints and deviations

- The harness asserts the API's actual `401 OPERATOR_AUTH_REQUIRED` response and verifies unchanged admin-run, audit and jobs counts.
- API, worker and PostgreSQL use an internal network; nginx also joins a browser network so Playwright can reach the packaged web. No market provider collection is enabled.
- Local Node was v24, outside the repository's Node 22 range. Remote checks used Node v22.22.1 and pnpm 11.8.0.
