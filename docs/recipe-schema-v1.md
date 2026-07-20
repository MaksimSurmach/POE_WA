# Recipe schema v1

`recipeV1Schema` validates the structured front matter before any recipe reaches
application or pricing logic. The resulting `CanonicalRecipeV1` is a domain
model and has no dependency on a Markdown or YAML parser. Human guide Markdown
remains separate and must never be used to infer trade queries.

## Required fields

Every recipe defines `schemaVersion`, `id`, `title`, `summary`, `tags`,
`category`, `gameVersion`, `baseRequirements`, `materials`, `success`,
`finishingCosts`, `craftSteps`, `output`, and `estimator`.

Optional fields are limited to base `itemClass`, `minItemLevel`, and
`influences`, plus per-step `metadata`. A recipe with no finishing cost must use
an empty `finishingCosts` array.

`success` accepts exactly one manually maintained model:

- `{ mode: "probability", probability: 0.25 }`
- `{ mode: "expected_attempts", expectedAttempts: 4 }`

Estimator configuration is strategy-specific. `nth_cheapest`, `median_top_n`,
and `mean_top_n` require `n` from 1 through 10; `percentile` requires a value in
the `(0, 100]` range.

## Unknown-field policy

Version 1 rejects unknown keys at every schema-owned object boundary. This
prevents misspelled automation fields from being silently ignored. Only the
explicit `tradeQuery.query` and `craftSteps[].metadata` payloads accept arbitrary
JSON because their keys belong to providers or future step-specific tooling.

`validateRecipeV1` throws `RecipeValidationError`; each issue includes a concrete
path such as `materials[0].quantityPerAttempt` or `output.tradeQuery.provider`.

## Markdown loader

Recipes live at `recipes/<recipe-name>/recipe.md`. Run `pnpm recipes:validate`
to load every file, validate its front matter, parse CommonMark without MDX,
check duplicate IDs, and verify referenced images. The loader preserves the
normalized Markdown body separately from `CanonicalRecipeV1` and returns recipes
in stable ID order.

Images must be relative regular files inside the recipe directory. PNG, JPEG,
GIF, WebP, and AVIF are accepted; remote URLs, traversal, symlinks, and missing
files fail validation. Raw HTML and JSX are rejected, while inert fenced code
examples remain valid Markdown.
