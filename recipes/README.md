# Manual recipe authoring

Copy `docs/recipe.template.json` to `recipes/<category>/<id>.json`.
The JSON-only recursive catalog requires unique IDs and schema version 3.
One recipe defines one exact output and one craft procedure. A second method
requires another recipe; identical outputs share their computed target signature.

Group output modifiers under `target.prefixes`, `suffixes`, `implicits` and
`other`. Define the acquired item under `startingBase` and the finished item
under `base`. Enter dated calculator evidence, per-stage expected executions
per finished item, and expected base consumption. Missing evidence or quantities
withhold expected cost and ROI. Do not infer a multi-stage total from one roll's
success probability. Material IDs must match verified exchange or Ninja details IDs.

Git is the recipe source of truth. Removing a recipe soft-disables it on the
next sync; database rows, raw snapshots and evaluation history remain.
Run `pnpm recipes:validate` and `pnpm recipes:sync --dry-run` before committing.

## 3.30, first week

Filter the catalog by `week-one` (or search `Week 1`) for 24 simple essence
craft candidates across eight equipment slots. Ordinary bases provide earlier
alternatives to tier-gated Atlas bases and level-84 ES bases. These are candidates,
not established profitable crafts. The acquisition search includes required links
and quality; no linking, fracture, metacraft or optional finish is treated as free.

The new recipes are `3.30.0`, with no probability, expected consumption or verified
league until the complete target is checked against 3.30 data. Trade identities
reuse the existing identity-only `3.29.3.3` manifest; this does not import old craft
odds into 3.30. Existing checked recipes retain their historical Allflame evidence.
See [the patch review and load estimate](../docs/evidence/poe-330-week-one-2026-11-11/README.md).
