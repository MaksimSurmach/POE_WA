# Recipe authoring

1. Copy `recipe.template.md` to `recipes/<unique-id>/recipe.md`.
2. Replace every placeholder while preserving `schemaVersion: 1`.
3. Run `pnpm recipes:validate` before committing.
4. Preview database changes with `pnpm recipes:sync --dry-run`.
5. Apply them with `pnpm recipes:sync` after migrations are current.

Git is the recipe source of truth. A removed `recipe.md` is soft-disabled by
the next sync; its database row and evaluation history are retained.

Validation reports the file and field for duplicate IDs, schema errors, unsafe
or missing image assets, malformed front matter, and invalid Markdown content.
