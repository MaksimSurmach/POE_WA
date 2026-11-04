# E0 implementation notes

## Run record

- Scope: E0. Starting SHA: `0421e4729ca43eb3f66e24bfc38a4e88309cccf8`.
- Branch: `codex/mi2-e0`; final candidate: `66bc08143784d44e16eae62444990cdbb6150089` (7 local commits, not pushed).
- Builds and runtime validation ran on Contabo via `ssh contabo-main-443`; local machine was used for code and docs only.
- Implemented exact-build artifact workflows, guarded manifest/image validation, isolated Compose smoke environment, packaged boot test, workflow action SHA pins, and launch instructions.

## Validation

- Contabo: frozen pnpm install, lint, typecheck, Compose config, Linux/amd64 Docker builds, harness self-check and packaged E2E passed.
- Smoke applied migrations twice, seeded 28 recipes, checked API/recipe reads and worker heartbeat, denied admin mutation with `401 OPERATOR_AUTH_REQUIRED` without DB side effects, loaded a direct recipe route and packaged assets, then removed only its labelled resources.
- Final verdict: **PASS candidate** for `66bc08143784d44e16eae62444990cdbb6150089`. Server image `sha256:28e382dc118a2bc92eb6adcc7a6f476437dc19846595a2bec26233792102a00d`; web image `sha256:44f53fb2087371ce77479fd441d70965fa96dbc8cfb5125bf8453cd23deafe9e`.
- Report and manifest: `output/master-e2e/`.
- GitHub Actions workflows were not run. This local candidate result is not a Master Build/E2E receipt or release acceptance. E1 was not started.

## Constraints and deviations

- The harness asserts the API's actual `401 OPERATOR_AUTH_REQUIRED` response and verifies unchanged admin-run, audit and jobs counts.
- API, worker and PostgreSQL use an internal network; nginx also joins a browser network so Playwright can reach the packaged web. No market provider collection is enabled.
- Local Node was v24, outside the repository's Node 22 range. Remote checks used Node v22.22.1 and pnpm 11.8.0.
