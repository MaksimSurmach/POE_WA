# Bounded policy review

Actionable findings: none confirmed.

Reviewed the current uncommitted compiler/domain, provider, category matcher, editor and cache-policy delta against the actual running `recipe-market.js` and `trade-compatible.js` snapshots supplied in `/tmp`.

- Finished-market equivalence preserves the running output-search relaxation; acquisition remains exact. Category searches are restricted to the three declared classes.
- Ignored item/tier fields are disabled and explained. Positive explicit/fractured maximum bounds remain editable with a strict-search-only label; implicit and negative bounds retain their meaning.
- Dependency digests include equivalence/category policy while the canonical target signature remains separate; policy edits cannot reuse a mismatched configured-result identity.
- Unsupported converted stats and known query-generation failures become item diagnostics. Category matching retains unknown evidence and rejects known conflicting classes.
- Origin aggregation preserves the running behavior, with duplicate same-origin contributions retained as ambiguous and combined rolls losing unsupported tier evidence. Raw observations remain intact.

Scope limit: source review only. Did not rerun the full suite, the 144-query production comparison, live collection, or any database writes. Existing running-provider behaviors were treated as the compatibility baseline, not re-audited wholesale.

Final browser follow-up: the independent visual pass confirmed group headers covering tile titles. Headers now occupy their own space above each tile layout; a browser assertion passes at 1440/768/390px, and actual-data desktop geometry shows every visible header ending exactly where its tiles begin. A separate actual-data popup check found the existing `targetTradeUrl` response field was never populated. It now uses the same compiled query/Trade URL helper; 34 resource-view tests pass and the actual popup exposes the exact generated Trade link.

Startup-data follow-up: independent audit loaded all 72 active-image recipes, checked 144 current specs and the three supported categories, and found only the retired Fugitive Boots runtime file absent from the deployment. Unrelated drafts remain. The copied catalogue passes a read-only startup dry-run against the actual database: 72 unchanged, no creates/updates/disables/failures. The normal shipped API and collector were then started locally and completed output and starting-base requests through PostgreSQL. Preserved hybrid-base defence metadata is typed and rendered, with a regression check.
