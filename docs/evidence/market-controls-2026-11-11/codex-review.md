# Independent Codex review

Reviewed the original `cc953be` change against `997cad6`, then the working-tree
remediation. Two separate reviewers covered correctness/standards and spec/UX.

## Standards and correctness

Two P2 findings:

1. Re-reading the latest settings version before saving an older age draft could
   silently overwrite another tab's edit. Fixed by comparing edited fields with
   the loaded baseline, retaining edited fields, rebasing untouched fields, showing current values, and requiring
   another explicit save after a conflicting edit.
2. Independently fetched catalog and trend responses could cross a league rollover.
   Fixed by pinning resource reads to one resolved league ID, declaring that ID in
   the catalog, filtering foreign results/readiness, and withholding mismatched
   historical comparisons and selected history. Unknown league fails closed.

Backend mixed-source/unresolved tests and delayed-response browser scenarios cover
these cases. A separate reviewer inspected the backend author's remediation.

## Spec and UX

One verified P2: nearby marks had overlapping 44px hit areas; 19 of 30 mark centers
selected a different recipe/group on a 390px view of the frozen live catalog.

Fixed without moving numerical coordinates. Pointer hits now offer every recipe
in overlapping hit areas; keyboard activation checks the focused mark's center.
The chooser shows each exact ask/activity value. Clearing probes verified all 30
mark centers and activated all 44 priced recipes through the chart at 390px.

The reviewer also injected mismatched overview and selected-history leagues and
confirmed historical percentages/detail charts were withheld while the catalog's
league label remained correct. Source review cleared the settings-conflict guard
and backend pinning. No remaining actionable Spec/UX blocker was reported.

## Limits

No production writes, Safari/Firefox run, launch-league economics, or live crafting
were part of this review. Claude contributed implementation but final review was
performed by independent Codex agents after its CLI quota was reached.
