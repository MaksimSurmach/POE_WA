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
