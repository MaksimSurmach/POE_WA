# E0 packaged candidate evidence

- Source/harness SHA: `213f8301fa5e1265988a2a6b8b4271e6089e3c9e`.
- Contabo `linux/amd64` local candidate; not a GitHub Master Build/E2E receipt.
- `verdict.txt` records `PASS` for `ACL-PUBLIC-01` and `BOOT-01`; `manifest.json` records exact image IDs and archive hashes; `report.json` is the Playwright result; `diagnostics.txt` contains migration and pg-boss queue snapshots.
- The queue snapshot recorded one `league.resolve` job in `retry`; Compose logs contained 20 `TRADE_MAPPING_MISSING` warnings during worker startup. These did not fail the E0 checks and remain limits for broader runtime acceptance.
- Image archives and full Compose logs were not committed.
