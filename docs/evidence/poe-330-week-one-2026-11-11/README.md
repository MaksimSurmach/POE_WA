# 3.30 recipe review and first-week candidates

Checked 2026-11-11 against [GGG 3.30.0 patch notes](https://www.pathofexile.com/forum/view-thread/4013680),
public [Trade items](https://www.pathofexile.com/api/trade/data/items),
[Trade stats](https://www.pathofexile.com/api/trade/data/stats), and the
[CoE changelog](https://beta.craftofexile.com/changelog), which still identifies
its current PoE 1 data as **3.29.3.3**. No in-game crafting, transactions or 3.30
profitability were verified. Recipe thresholds are authored candidate benchmarks,
not a claim of measured build demand or optimal profit.

## Existing 31 recipes

No active method uses attack/caster-protected Annul, Recombinator, Rog, the
changed Harvest conversion crafts, or a full prefix/suffix lock at its old price.
There is therefore no recipe to delete for those changes. Do not introduce the
new partial locks into a cost model before their selection behaviour is checked.

- Bone Helmet: the historical recipe and receipt keep the 3.29 implicit benchmark.
  The new 3.30 recipe explicitly requires the new **20%+** minion-damage implicit,
  life 91+, +1 minion gems and fire resistance 30+.
- Existing Stygian methods: acquisition must be repriced as base supply changes.
- Existing fractured methods: they purchase an already-rare fractured item.
  They do not assume the new magic drops are rare, or price a free upgrade.
- Cluster targets do not combine the small-passive attack/cast-speed modifiers
  whose family changed. Their historical probabilities remain historical.

All 31 retain their original patch and calculator artifacts. The three physical
cluster recipes withdraw Standard/Hardcore cost certification across the patch
transition, while retaining their recorded challenge-league certification.
Each now records the 3.30 review scope in its notes. The existing publisher checks
the verified league before publishing expected cost or ROI. Tests cover both an
unverified model and a verified model from another league with fresh prices.

## New 24 candidates

All use one paid essence step, an acquired rare base, and an AND stopping condition.
No fracture, influence, protected Annul, metacraft or bench finish is required.
There is no invented success probability, execution count or verified league.
Prices and comparable listing evidence can be collected while total craft cost
and ROI remain unavailable. Use the `week-one` tag in the existing catalog filter.

| Slot            | Bases / targets                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Belts (4)       | Leather / Heavy / Stygian: life 100+, fire 30+, chaos 31+ via Envy; Crystal: explicit ES 38+, fire/cold 30+ via Woe                                                                                  |
| Helmets (4)     | Bone: +1 minions, life 91+, fire 30+, implicit 20+; Hubris: ES 250+; Lich: ES 300+; Royal Burgonet: life 91+, fire/cold 30+                                                                          |
| Gloves (6)      | Fingerless: ES 140+; Warlock: ES 180+; Gripped / Spiked: life 70+, speed 17+, fire 30+; Apothecary: new DoT multiplier implicit, life 91+, fire/cold 30+; Slink: life 70+, speed 17+, suppression 8+ |
| Boots (4)       | Two-Toned / Fugitive / Slink: Zeal's 32% movement, life 70+, resistances or suppression; Warlock: ES 180+, movement 25+, fire 30+                                                                    |
| Bows (2)        | Purchased six-link Thicket: +2 bow gems and local speed 14+ via Shrieking Dread; Spine: physical damage and local speed via Contempt                                                                 |
| Quiver (1)      | Broadhead: life 70+, explicit speed 13+, fire 30+ via Zeal                                                                                                                                           |
| Body armour (2) | Purchased six-link, 20% quality Vaal: ES 550+ / Twilight: ES 750+, fire 30+, via Woe                                                                                                                 |
| Shield (1)      | Titanium: ES 200+, fire 30+ via Woe                                                                                                                                                                  |

ES targets use the existing native displayed-ES filter, not the flat-ES affix as
a substitute. Physical bow flat damage uses the Trade average of the damage pair;
the recipe does not claim a DPS threshold. Thicket and both body recipes price
an already-linked base. Local bow speed uses the local Trade stat, not global
attack speed. Atlas implicits are retained, with no Eldritch replacement step.

Lich, Warlock and Twilight are the high-level ES choices; Hubris, Vaal and ordinary
bases provide earlier alternatives. Stygian, Crystal and Atlas bases depend on
changed supply. These distinctions are recorded in individual recipe notes.

## Collection load

The schedule integration test reconciles **55 recipes into 94 unique Trade
targets** plus the existing economy/league/retention rows, preserves runtime state
on repeated sync, and disables removed targets safely. No interval changed:
49 hourly outputs + 45 two-hourly bases = **71.5 captures/hour**, versus 35.5 before
expansion. Optional discovery targets, retries and other IP traffic are additional.

At 09:42 UTC on 2026-11-11, the public diagnostic showed fresh successful Standard
captures after the earlier provider incident, a live single collector and no
tracked 429. Its successful-capture average was 1.023 search / 2.977 fetch requests.
Keeping that mix projects **73.1 search / 212.9 fetch requests/hour**, compared with
the currently paced 150 / 250. See [the measured projection](load-projection.json).

This is not a successful expanded-catalog load test. More than **3.50 fetches per
capture on average** would exceed the projected fetch pacing capacity. Broad base
searches, retries, price slices and league-launch volume can change the mix.
The durable limiter and 25% reserve remain intact; check queue age, overdue
intervals, request counts and complete-capture coverage after activation. Do not
interpret a lack of 429 as proof the hourly cadence is being met.

## Validation

- Catalog: all 55 recipes validate, with resolvable identities and presentation.
- Unit tests: 841 passed (187 domain, 18 contracts, 539 server, 97 web), plus the
  native runtime script check. New first-week and evidence-gating tests included.
- PostgreSQL 17: all 191 integration tests passed, plus eight targeted recipe-sync/
  collector-schedule tests and eight backend E2E tests.
- Build, lint, typecheck and dry-run recipe sync passed locally.
- Final unit, lint, typecheck and build checks also passed on Node 22.22.0,
  matching repository CI. Actual 3.30 probabilities and launch load remain open.
