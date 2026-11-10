#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
unset DATABASE_URL COLLECTOR_DATABASE_URL
unset POE_TRADE_USERNAME POE_TRADE_PASSWORD POE_TRADE_SESSION_ID POE_TRADE_SESSION_KEY
export APP_ENV=development DATABASE_SSL_MODE=disable
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export OPERATOR_DIAGNOSTICS_TOKEN="$(openssl rand -hex 32)"
export MARKET_COLLECTION_SOURCE=disabled POE_TRADE_ACCESS=disabled
export PIPELINE=collector COLLECTOR_RETENTION_ENABLED=false

overlay=$(mktemp)
cat > "$overlay" <<'YAML'
services:
  app:
    ports: !reset []
networks:
  default:
    internal: true
YAML
compose=(docker compose --env-file /dev/null -p "worksmith-server-smoke-$$" -f compose.server.yaml -f "$overlay")
cleanup() {
  local status=$?
  if (( status != 0 )); then "${compose[@]}" logs --no-color || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  rm -f "$overlay"
}
trap cleanup EXIT

test "$("${compose[@]}" config --services | sort | xargs)" = 'app collector postgres'
"${compose[@]}" up -d --build --wait --wait-timeout 120 app
"${compose[@]}" exec -T postgres psql -U worksmith -d worksmith -v ON_ERROR_STOP=1 <<'SQL'
insert into poe_leagues (ggg_id, name, is_current, synced_at)
values ('FixtureGGG', 'Fixture display name', true, now());
insert into game_data_versions (game, patch_version, source, source_revision, manifest_hash, status)
values ('poe1', '3.29.3.3', 'fixture', 'fixture', 'collector-schedule', 'active');
SQL
for mapping in physical-large-cluster recipe-catalog; do
  "${compose[@]}" exec -T app node dist/entrypoints/tradeMappings.js "mappings/poe-trade/3.29.3.3/$mapping.json"
done

"${compose[@]}" up -d --build collector
"${compose[@]}" exec -T app node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = 'http://127.0.0.1:8080';
const ready = await fetch(base + '/health/ready');
assert.equal(ready.status, 200);
assert.equal((await ready.json()).status, 'ready');
assert.match((await fetch(base + '/')).headers.get('content-type'), /text\/html/);
const statusUrl = base + '/api/collector/status';
assert.equal((await fetch(statusUrl)).status, 401);
let status;
for (let attempt = 0; attempt < 60; attempt++) {
  const response = await fetch(statusUrl, {
    headers: { authorization: 'Bearer ' + process.env.OPERATOR_DIAGNOSTICS_TOKEN },
  });
  assert.equal(response.status, 200);
  status = await response.json();
  if (status.lockHeld && status.nextDueAt) break;
  await delay(1000);
}
assert.equal(status?.lockHeld, true);
assert.ok(status?.nextDueAt);
JS
"${compose[@]}" logs --no-color collector | grep -F 'leader acquired'
test "$("${compose[@]}" exec -T postgres psql -U worksmith -d worksmith -XAtc "select enabled from collector_schedule where kind = 'retention' and key = 'retention'")" = f

"${compose[@]}" exec -T collector node --input-type=module <<'JS'
import { chromium } from 'playwright';

const profile = await chromium.launchPersistentContext(process.env.POE_TRADE_BROWSER_PROFILE_DIR, {
  chromiumSandbox: true,
  headless: true,
});
await (await profile.newPage()).goto('about:blank');
await profile.close();
JS
"${compose[@]}" up -d --force-recreate --no-deps collector
"${compose[@]}" exec -T collector node --input-type=module -e "import { access } from 'node:fs/promises'; await access(process.env.POE_TRADE_BROWSER_PROFILE_DIR + '/Default/Preferences');"

"${compose[@]}" stop postgres
"${compose[@]}" exec -T app node --input-type=module -e "import assert from 'node:assert/strict'; const r = await fetch('http://127.0.0.1:8080/health/ready'); assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'PERSISTENCE_UNAVAILABLE');"
