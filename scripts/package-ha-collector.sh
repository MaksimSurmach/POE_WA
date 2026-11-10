#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
archive=${1:?Usage: package-ha-collector.sh /absolute/path/to/addon.tar.gz}
case "$archive" in
  /*) ;;
  *) printf '%s\n' 'Use an absolute archive path.' >&2; exit 2 ;;
esac
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp -R services/market-trade-scraper "$stage/addon"
pnpm --filter @poe-worksmith/server... build
pnpm --filter @poe-worksmith/server deploy --prod --legacy "$stage/addon/runtime"
cp -R recipes "$stage/addon/runtime/recipes"
node "$stage/addon/runtime/dist/recipes/validateCatalog.js" "$stage/addon/runtime/recipes"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$stage/addon" .
