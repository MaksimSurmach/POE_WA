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

Filter the catalog by `week-one` for 23 simple essence
craft candidates across eight equipment slots. Ordinary bases provide earlier
alternatives to tier-gated Atlas bases and level-84 ES bases. These are candidates,
not established profitable crafts. The acquisition search includes required links
and quality; no linking, fracture, metacraft or optional finish is treated as free.

The ordinary Slink boots/gloves recipes use `base-independent` output comparisons:
Trade searches the equipment category and required modifiers, without an exact
base type. Slink remains the ordinary evasion reference for acquisition/crafting.
Recipes with valued native implicits or defence targets retain their exact bases.
The Fugitive starter recipe is retired: its separate price primarily reflected
the premium base rather than a distinct functional modifier target.

The new recipes are `3.30.0`, with no probability, expected consumption or verified
league until the complete target is checked against 3.30 data. Trade identities
reuse the existing identity-only `3.29.3.3` manifest; this does not import old craft
odds into 3.30. Existing checked recipes retain their historical Allflame evidence.
See [the patch review and load estimate](../docs/evidence/poe-330-week-one-2026-11-11/README.md).

## Influenced rings and fractured T1–T2 bases

Filter by `user-craft` for eight additional 3.30 candidates: Hunter Amethyst /
Vermillion rings with Reforge Caster, Lich's / Sunfire Circlets with a T2 fire
resistance fracture and Loathing, and Velour / Harpyskin / Wyvernscale /
Chimerascale gloves with T2+ suppression fractures and Zeal. These require
already-rare ilvl 85 bases. T1–T2 names the top two ordinary defence bases in
each selected armour family; rings are useful base alternatives, without an
official shared tier ranking. No expected cost or ROI is certified.
See [targets and checked identities](../docs/evidence/influenced-fractured-2026-11-15/README.md).
