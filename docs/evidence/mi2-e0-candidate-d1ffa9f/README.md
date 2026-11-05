# E0 packaged candidate evidence

- Source/harness SHA: `d1ffa9f10bfa0502b954c4798f337e222ca5b908`.
- Contabo `linux/amd64` local candidate; not a GitHub Master Build/E2E receipt.
- `verdict.txt` records `PASS` for `ACL-PUBLIC-01` and `BOOT-01`; `manifest.json` records exact image IDs and archive hashes; `report.json` is the Playwright result; `diagnostics.txt` contains migration and pg-boss queue snapshots.
- A first smoke attempt on these exact images failed during the initial recipe API read with a PostgreSQL connection timeout; teardown succeeded. The same images passed on rerun. The cause of the first timeout is unknown, so this remains a flakiness signal.
- The successful run recorded one `league.resolve` job in `retry`; Compose logs contained 20 `TRADE_MAPPING_MISSING` worker startup warnings. These did not fail the E0 checks and remain limits for broader runtime acceptance.
- Image archives and full Compose logs were not committed.
