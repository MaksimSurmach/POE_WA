# Manual recipe authoring

Copy `docs/recipe.template.json` to a category folder, for example
`recipes/cluster-jewel/<id>.json`, and keep IDs unique. JSON recipes and existing
`recipe.md` files load through the same recursive catalog.

Use `craft.variants` for ordered methods and steps. Enter step probabilities and
expected executions only with dated, linked evidence. Enter expected
executions per finished item for each material-consuming step; otherwise the
expected total remains unavailable. Step quantities may be `null` when not
verified, which prevents a calculated total.

Git is the recipe source of truth. Removing a recipe soft-disables it on the
next sync; its database row and evaluation history remain. Run
`pnpm recipes:validate` before committing and `pnpm recipes:sync --dry-run` to
preview changes.
