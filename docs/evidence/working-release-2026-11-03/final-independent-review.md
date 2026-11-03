# Final independent source review

Codex research_acceptance reviewed the exact-level acquisition/query/matcher change, per-recipe EV invalidation and historical evaluation preservation. It found a reproducible P2 in the first exchange split: a legacy headerless 429 Retry-After was bypassed by the new endpoint.

The correction in `75dfd5d` was re-reviewed against current TypeScript source. 39 focused source tests passed, including mapped/orphaned 429/503 deadlines and independence from ordinary generic/named-search pacing. The reviewer found no remaining reproducible P1/P2 in the requested delta. It did not edit code or the database and did not rerun live/PostgreSQL checks.

Root separately exercised the named cooldown, orphaned access denial and headerless 429/503 variants against real isolated PostgreSQL; 12 limiter integration cases passed. The Bone implicit acquisition guard is an additional narrow input requirement, independently covered by query and raw-normalizer tests; it does not claim to resolve the emulator's item-replacement behavior.

Claude Code was used for the earlier source/runtime/research/packaging reviews until the recorded five-hour quota was exhausted. Later source reviews are explicitly Codex reviews, not Claude or formal GitHub approvals.
