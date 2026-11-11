# Independent finish review — 11 November 2026

## Disposition

**Ship within this visual review's scope — all 3 findings resolved.** The incumbent HeroUI / Inter / dark blue direction is coherent. The final verdict pass inspected only the three existing findings in recaptured home/market desktop and mobile evidence, the two search-empty states, and the corresponding source changes. It was not a new audit of every route or runtime state. No rebuild is warranted.

Reviewed the original task/direction document, the craft floor, the source changes against `origin/master`, all seven route types at desktop and mobile, selected history at both widths, and the expanded desktop guide calculator. First-viewport screenshots were opened separately at readable size; extremely tall full-page captures were supporting evidence only.

## Material findings

Follow-up scoring (only the original three findings; no new audit):

- **Finding 1: pass at both widths.** The final `market-mobile-viewport.jpg` separates the complete three-line title from “Chaos Orb · 3 Notables”; desktop rows also separate title and method. The source uses a content-height block button.
- **Finding 2: pass in final default-state evidence.** At **390×900, default filters, initial scroll position**, `home-mobile-viewport.jpg` shows one complete target identity, its “Materials and steps” action, and its observed ask of 25 c, while keeping the profit limitation readable. Class/view and other filters are findable through “Filter targets”; search stays direct. The implementer's CUA measurements put the identity at y=631.5–727.9, action at 699.6–727.9, and ask block at 740.9–812.8, consistent with the independently viewed capture. Desktop retains the same complete target workflow. This closes the exact first-fold requirement; the earlier partial title-only pass did not.
- **Finding 3: pass at both widths.** Final `market-empty-search-{desktop,mobile}.jpg` show only the correct no-matches recovery, and the source gates the collection-empty message on `response.data.entries.length`.

Original evidence and fixes requested (historical; those screenshot paths have since been overwritten with final captures):

1. **P2 — Market recipe titles collide with their method.** `apps/web/src/RecipeMarketOverview.tsx:220-236`; `apps/web/src/clarity.css:350-353`. In `market-mobile-viewport.jpg` and `market-mobile.jpg`, the first title wraps to three lines and its last line (“/ Veteran Defender”) overlaps “Chaos Orb · 3 Notables”. The second row repeats this with “Jagged Fossil”. The HeroUI button keeps a fixed height while its text grows; a minimum height alone does not let the method move down. Allow the button to grow to its full wrapped content height, with the method in a separate flow row. Keep the whole title actionable and verify the longest title at 390px.

2. **P2 — The mobile opportunities landing screen contains no opportunity.** `apps/web/src/App.tsx:201-253`; `apps/web/src/clarity.css:293-307`. At 390×900, `home-mobile-viewport.jpg` reaches only the first group heading at approximately y=853; no target title, asking price, or target action is visible. The summary, four view buttons, search/class controls, reset and sort consume the first screen. This preserves the principal clutter problem on the main narrow-screen workflow. Compact or disclose secondary summary/filter controls so the first target and its next action are visible in the initial viewport, retaining the honest profit limitation and accessible filtering.

3. **P2 — An empty search incorrectly reports missing collection data.** `apps/web/src/RecipeMarketOverview.tsx:115-117`. `entries` is now the search-filtered array, but an empty result displays “No recipes are available yet. Check collection in Settings.” The table simultaneously provides the correct “No recipes match this search” recovery. A valid catalog with a nonmatching query therefore suggests a collector problem. Gate the unavailable-catalog message on the raw response entries, leaving search-empty guidance for filtered results. Evidence is the source path; this state was not in the supplied screenshots.

## Craft-floor assessment

- Hierarchy and language improve materially: truthful decision summary; observed asks distinguished from sales; procedure/base/target ahead of advanced tools; optional evidence disclosed in place. Desktop content and actions fit in the initial evidence. Mobile guide, recipe, Factory and Settings remain readable. Final opportunities evidence exposes the target, ask and next action in the first fold.
- The existing dark palette, Inter, blue actions, familiar navigation and real item art remain consistent. No new decorative world, fabricated metrics or hero-card scaffolding was introduced. Source adds focus indication, selection colors, scrollbar colors and tabular timestamps.
- Selected history fits its actual container at both widths. Intraday labels are readable, the UTC legend is explicit, flat observations remain flat, and missing intervals remain gaps. Unknown activity stays distinct from measured zero in the table and source.
- Screenshot review cannot establish measured contrast, actual keyboard behavior, hover/loading/error behavior, or reduced-motion behavior. Detector output was `[]`; it did not detect the long-title collision.

## Requirement coverage

| Surface           | Coverage                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opportunities     | Honest availability, populated economics only, grouped methods and direct materials/steps links; mobile first-screen issue resolved in the final default-state capture.                                 |
| Recipe library    | Market recipes first; source groups, methods and steps links are clear at both widths.                                                                                                                  |
| Market recipe     | Base and target precede steps; failure/recovery remains visible; unavailable cost/profit tiles and advanced evidence are reduced.                                                                       |
| Pohx guide        | Full-width procedure before optional calculator; source date, league caveat and manual assumptions remain explicit.                                                                                     |
| Market / history  | Table before optional plot; zero/unknown distinction, search/order controls, responsive history and intraday labels. Row collision and search-empty copy are resolved in final desktop/mobile evidence. |
| Factory           | Empty state opens creation; empty totals/pagination removed; historical start and forecast inputs disclosed. No accounting change found in reviewed diff.                                               |
| Settings / shared | Dedicated destination, collector controls and quote-age settings; explicit 24-hour timestamp labels. Chart history intentionally remains UTC.                                                           |

## Limits

No browser session or live writes were performed by this reviewer. Production captures are point-in-time evidence; the default Factory is empty. Expanded mobile guide calculator, expanded scatter plot, populated Factory, and all transient states lack independent visual coverage here. Unit/build/lint and browser results were supplied by the implementer, not rerun independently. No profitability, sales, demand, backend or ledger correctness is certified by this visual review.
