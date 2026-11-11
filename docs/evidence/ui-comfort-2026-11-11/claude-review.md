## Review: `codex/worksmith-ui-comfort` vs `0b8504f`

**Verdict: don't merge as-is.** Two things need fixing first: a browser spec that still asserts the old phone layout, and the desktop table clipping that PR #102 resolves. I read source and the five screenshots only; I ran no tests, builds or browsers, and could not see PR #102's diff.

### Defects

**1. High — browser spec contradicts the new phone layout** (from reading; not run)

- **Where:** `tests/browser/two-methods.spec.ts:49-58`, which this diff does not touch.
- **Trigger:** running the suite with `BROWSER_FIXTURE_SCENARIO=two-methods-priced` (it is skipped otherwise, so a default run will not show it).
- **Consequence:**
  - Line 54 expects the row header to contain the profit at 390px. The diff deletes the `craft-table__phone` block, so profit now sits in its own `<td data-label="Profit">` and the assertion fails.
  - Line 57 expects the "Item class" column header to be hidden. The `<th>` is now clipped rather than `display: none` (`catalogTable.css:263-272`), and only its button gets `visibility: hidden`, so Playwright will very likely still report it visible.
- **Smallest fix:** change line 54 to `expect(row).toContainText(profit)` and update the comment on line 53. Change line 57 to assert the `Item class` button is hidden, or that `.craft-table__class` is hidden.

**2. Medium — desktop table now clips inside its own scroll box** (seen in screenshot)

- **Where:** `catalogTable.css:58-65` (`max-height: 75vh`) combined with the larger row padding at `:78` and the larger fonts.
- **Trigger:** 1440px wide with the 7 fixture rows.
- **Consequence:** `before-catalog-1440.png` shows all 7 rows; `after-catalog-1440.png` cuts off "Suppression Gloves" mid-row inside the nested scroller. The comfort spacing makes the nested scroll worse.
- **Smallest fix:** land #102's desktop removal of `overflow`/`max-height`. Both PRs edit the same rule, so resolve by hand: keep this branch's `margin-block` and its ≤620px block (`:253-257`). If #102 leaves `overflow-x: auto` on the wrapper, check the sticky header at `:84` still sticks.

**3. Low — phone sort control** (from reading)

- **Where:** `CatalogTable.tsx:88-97`.
- **Trigger:** ≤620px.
- **Consequence:** "Item class" is offered as a sort key, but that cell is hidden on cards (`catalogTable.css:314`), so the resulting order is unexplained. The direction button's only name is its state ("Descending ↓"), with nothing saying it toggles.
- **Smallest fix:** add `aria-label={`Sort direction: ${…}, activate to reverse`}` to the button, and either filter `category` out of the select or show the class in the card subtitle.

**4. Low — dead tab stop on phones** (from reading)

- **Where:** `CatalogTable.tsx:74` (`tabIndex={0}`) with `catalogTable.css:253-257` (`overflow: visible`).
- **Trigger:** keyboard navigation at ≤620px.
- **Consequence:** an extra focus stop that scrolls nothing, with a focus ring around the entire card list.
- **Smallest fix:** `.catalog-table-scroll:focus-visible { outline: none }` inside the 620px block, or drop `tabIndex` if #102 removes the scroller on desktop too.

**5. Low — alternative methods lose their indent on phones** (from reading)

- **Where:** `catalogTable.css:285-291` overrides the indent at `:199`; the old 18px phone indent rule was deleted.
- **Trigger:** a target with 2+ methods at ≤620px.
- **Consequence:** "Other method" cards look the same as primary cards apart from the subtitle text.
- **Smallest fix:** `.craft-table__alternative { margin-left: 16px }` in the 620px block.

**6. Low, cosmetic — recipe page elements sit flush against the section border** (seen in `after-recipe-1440.png`)

- **Where:** `styles.css:1020-1032`; markup at `RecipePage.tsx:451-461` and `:475`.
- **Consequence:** the Price history range buttons, the "Compare in market trends" link and the "JE" tile in Base and target touch the left border, while everything else is now inset 20px. I did not open the before-recipe screenshot, so the misalignment may be older and only more visible now.
- **Smallest fix:** `.recipe-detail--compact .detail-section > .item-preview, … > .recipe-link { margin-inline: 20px }`, plus the trend panel wrapper.

### Speculative (not verified)

- **Safari / VoiceOver table semantics:** `display: block` and `grid` on the table, body and rows (`catalogTable.css:258-284`) can drop table roles in some WebKit versions. Explicit `role` attributes would guard against it.
- **Tablet-width table (621–1048px):** numeric columns are 100px with 24px padding at a 16px no-wrap font, so values like `+14,475 c` may spill into the next cell. Raising `min-width` to about 1120px would cover it.
- **Nav focus ring at 621–820px:** `overflow-x: auto` on the nav (`styles.css:1814-1817`) will clip the 4px-offset focus outline. The four links fit at that width, so the overflow rule can go.
- **Other screens:** the global changes (`--font-body`, `--font-small`, `line-height: 1.5`, 1360px content width) affect Factory, Market trends, the Pohx guide and the phone recipe page. None of the five screenshots I was given covers those, and I did not open the other captures in the folder (e.g. `after-library-1440.png`).

### Checked and found fine

- **Sorting and URL state:** the phone select and direction toggle round-trip through the URL correctly.
- **Phone evidence:** every card shows the Market evidence block (`after-catalog-390.png`).
- **Cascade:** the nav rules win over `marketTrends.css` given the import order; the Pohx economics strip keeps its flex layout; the collector controls grid matches its three children.
- **Unit tests:** the `App.test.tsx` "Worksmith Handbook" assertion still matches via the brand link's label.

## Resolution

- Updated the two-method browser acceptance to assert the dedicated profit cell and visible market evidence on phones.
- Combined #102: the catalog scrolls with the page on desktop; retained mobile labelled cards and all evidence.
- Item class is visible in the phone subtitle, and the direction button explicitly announces its action.
- Removed the redundant wrapper tab stop. Native sorting controls and recipe links remain keyboard reachable.
- Alternative methods retain a visual indent on phones.
- Recipe preview tiles, trend controls and the market link use the same content inset. The tablet nav no longer clips focus outlines through an unnecessary overflow container.

The global font changes were additionally exercised on the catalog, library, recipe, Pohx guide, Market and Factory at four widths; Market/Factory use unavailable-data states. Safari/VoiceOver and production data are not claimed verified.

## Follow-up review

**Verdict: merge. No remaining blockers.** All six earlier findings are resolved in the current source, and the refreshed screenshots confirm the ones they can show. I read source, the three screenshots, `capture.mjs` and `checks.json`; I ran nothing.

### The six points you asked about

| #   | Finding                      | Status          | Evidence                                                                                                                                                                                                                                                       |
| --- | ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Browser spec                 | Fixed           | `tests/browser/two-methods.spec.ts:54-59` now asserts profit in `[data-label="Profit"]`, a visible evidence cell, and that the `Item class` button is hidden. No other spec or test references the removed `craft-table__phone` block or the old region label. |
| 2   | Desktop nested scrolling     | Fixed           | `catalogTable.css:58-64` has no `max-height`. `after-catalog-1440.png` shows all 7 rows down to Suppression Gloves, scrolling with the page.                                                                                                                   |
| 3   | Mobile sort and class naming | Fixed           | The class appears in the card subtitle (`CatalogTable.tsx:192-194`, visible in `after-catalog-390.png`), so sorting by Item class is now explained. The direction button's label says it reverses (`:96`).                                                     |
| 4   | Wrapper tab stop             | Fixed           | `tabIndex` is gone from the wrapper (`CatalogTable.tsx:70-74`), and its label no longer promises scrolling.                                                                                                                                                    |
| 5   | Alternative method indent    | Fixed in source | `catalogTable.css:297-299` applies a 16px left margin to alternative cards on phones.                                                                                                                                                                          |
| 6   | Recipe section insets        | Fixed           | `styles.css:1789-1795`. In `after-recipe-1440.png` the range buttons, "Compare in market trends" and the JE tile line up with the 20px text inset.                                                                                                             |

The tablet nav overflow rule from my speculative list is also gone, so focus rings are no longer clipped there.

### Limits of this verdict

- **Spec not run by me:** the two-methods spec is skipped unless `PIPELINE=legacy` and `BROWSER_FIXTURE_SCENARIO=two-methods-priced` are set. Nothing I was given shows a run with those flags; if there hasn't been one, do it before merging.
- **Indent not seen:** the capture fixture has no multi-method target, so no screenshot shows the phone indent on an "Other method" card. That same spec run would exercise the layout.
- **Not covered:** Safari/VoiceOver table semantics with the grid card layout, and production data. The evidence file already says these are unverified.

### Non-blocking observations

- **Tablet keyboard scrolling:** between 621px and about 1040px the table still scrolls horizontally inside its wrapper, which is now not focusable. Keyboard users can still reach every column through the header sort buttons, so I don't consider it a blocker.
- **Risk section inset:** in "Expected value & risk", the error text and "Retry analysis" button sit a few pixels left of the 20px inset. The diff doesn't touch that section.
