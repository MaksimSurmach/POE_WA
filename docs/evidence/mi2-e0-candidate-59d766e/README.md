# E0 packaged candidate evidence

- Source/harness SHA: `59d766e1472f2ac6d0a91c55f578f005ee768cdf`.
- Contabo `linux/amd64` local candidate; not a GitHub Master Build/E2E receipt.
- `verdict.txt` records `PASS` for `ACL-PUBLIC-01` and `BOOT-01`; `manifest.json` records exact image IDs and archive hashes; `report.json` is the Playwright result; `diagnostics.txt` contains migration and pg-boss queue snapshots.
- The queue snapshot recorded one `league.resolve` job in `retry`; Compose logs also contain `TRADE_MAPPING_MISSING` warnings during worker startup. These do not fail the E0 smoke checks and remain a limitation for broader runtime acceptance.
- Image archives and full Compose logs were not committed.
