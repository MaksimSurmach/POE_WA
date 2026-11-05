# E0 packaged candidate evidence

- Source/harness SHA: `544d0aef71eeb4ff92217300d0eedce9b0f79ad9`.
- Contabo `linux/amd64` local candidate; not a GitHub Master Build/E2E receipt.
- `verdict.txt` records `PASS` for `ACL-PUBLIC-01` and `BOOT-01`; `manifest.json` records exact image IDs and archive hashes; `report.json` is the Playwright result; `diagnostics.txt` contains migration and pg-boss queue snapshots.
- A prior candidate (`d1ffa9f`) had one initial recipe API read timeout; its teardown succeeded, and a rerun passed. The final `544d0ae` candidate passed on its first attempt. The earlier timeout's cause is unknown.
- The successful run recorded one `league.resolve` job in `retry`; Compose logs contained 20 `TRADE_MAPPING_MISSING` worker startup warnings. These did not fail the E0 checks and remain limits for broader runtime acceptance.
- Image archives and full Compose logs were not committed.
