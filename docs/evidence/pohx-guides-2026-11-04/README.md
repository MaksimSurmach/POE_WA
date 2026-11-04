# Pohx recipe library acceptance — 2026-11-04

All 27 entries from https://pohx.net/crafts/ are browsable under `/recipes?source=pohx`, alongside the 26 existing market targets. The index, source URL and source-text SHA-256 are recorded in `source-coverage.json`; full copyrighted source text is not redistributed. Each authored summary links back to its complete procedure.

26 entries offer explicit spending scenarios; Abyss Socket Mittens is unfinished at the source and has no invented procedure or calculator. These are not 26 newly verified probability models. The basic Elder Fire Trap guide links the two already checked exact variants. Socketed-RF and Fire Trap targets remain distinct. The jewels summary retains the source’s recommendation to buy rather than craft.

## Cost integrity

- Cost is all bases/donors/replacements + total material consumption × unit price + other spending not already included. Failed attempts and recovery must be included by the user. Quantities and sale price are explicit assumptions, never source shopping budgets treated as expected attempts.
- Profit = assumed sale − cost; ROI = profit / cost × 100%. Decimal arithmetic is shared with domain economics. Missing/invalid quantities, bases, extras or consumed-material prices suppress the result; explicit zero is allowed. No sale means cost only; zero cost means no ROI. Losses remain negative.
- Current-league saved Currency/Essence/Fossil/Resonator quotes use the configured freshness policy and existing currency converter. Successful fetch/304 revalidation advances freshness; cache hits, failures, wrong leagues and future attempts do not. Quote expiry also respects exchange-rate expiry. Missing prices require manual input and never become free materials.
- Inputs persist in the recipe URL; automatic quotes are re-read and expire. These scenarios never enter the profitability ranking. Other-cost labels prevent counting the same material twice.

## Validation

- 595 Vitest tests plus the native-runtime control self-check passed.
- 140 PostgreSQL integration tests passed on an isolated cluster/database, including the publisher using the extracted shared revalidation helper.
- Build, lint, 26 canonical recipe validation and changed-file formatting passed.
- Browser: 53 total entries, 27 source-filtered entries, six helmets; search/class/source filters, unknown route, unfinished guide, two exact FT links, reload persistence, missing-input suppression and failed-price-request recovery passed.
- Browser arithmetic: 100c bases + 10c extras + 2 × 5c = 120c; 144c assumed sale = 24c profit and 20% ROI; reload preserved inputs/results.
- Widths 320/390/768/1440: document width equals viewport; only material table scrolls horizontally on small screens. Desktop/mobile screenshots attached. No page errors in normal navigation; the offline test intentionally aborted the quote request.
- Independent code review found and resolved the HTTP304 freshness gap. Independent source review covered all 27 guides and found/resolved the non-fractured T9 Dexterity and non-Shaper/non-Elder influence preparation omission in both minmax helmet routes.
- Design detector reported incumbent font choice and spacing/text-size issues; local guide spacing, measure and timestamp size were corrected. Existing font was preserved. Physical devices and screen-reader speech were not tested.

## Limits and next candidates

No in-game crafts, executed sales or complete expected-cost models for the 26 scenario guides were verified. Advanced guides depend on the linked recovery trees and Allflame mechanics. A useful guide does not establish positive ROI. Source guide review date is visible; new-league mechanics require review.

Suggested next models, subject to a demand and exact-output audit:

1. RF medium clusters with Fan the Flames: a build-relevant additional target, rather than another large-cluster duplicate ([Pohx FAQ](https://pohx.net/faq/)).
2. Utility flasks with exact prefix/suffix tiers: start with narrow two-affix targets and include quality/automation finish costs ([Craft of Exile](https://www.craftofexile.com/?a=x&am=aa&as=1&b=62&bp=y&hb=0&l=a&lg=4&m=alteration&ob=both&req=&v=d)).
3. Convert the newly added fractured RF gloves and straightforward essence routes into verified automatic models before tackling multi-donor minmax recombination ([Pohx gloves](https://pohx.net/crafts/gloves/)).

These are research priorities, not claims of current profit.

## Installed runtime

Release `pohx-guides-20261104` installs code `f55c676`. Manual start/readiness, the installed 27-of-53 library, current-league material API (178 saved quotes) and link to the checked FT variant passed. Collection settings were restored exactly at version 18. Manual shutdown passed; API, web and PostgreSQL, including temporary preview/test ports, are stopped. Login autostart remains disabled. Previous release and a pre-change database backup are retained; see `installed.json`.

[CI for installed code f55c676](https://github.com/MaksimSurmach/POE_WA/actions/runs/41842035399) passed, including backend end-to-end checks and both Docker builds. The subsequent commit records installation evidence only.
