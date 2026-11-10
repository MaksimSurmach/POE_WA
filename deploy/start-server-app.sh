#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${COLLECTOR_DATABASE_URL:-$DATABASE_URL}" node --input-type=module - <<'JS'
import { loadRuntimeConfig } from './dist/runtimeConfig.js';
loadRuntimeConfig(process.env, 'collector');
await import('./dist/migrate.js');
JS
unset COLLECTOR_DATABASE_URL

node dist/entrypoints/api.js &
api_pid=$!
env -i /usr/sbin/nginx -c /etc/nginx/worksmith.conf -g 'daemon off;' &
web_pid=$!

trap 'kill -TERM "$api_pid" 2>/dev/null || true; kill -QUIT "$web_pid" 2>/dev/null || true; wait || true' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
wait -n
