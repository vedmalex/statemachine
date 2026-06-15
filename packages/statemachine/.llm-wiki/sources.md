<!-- Template for llm-wiki-* family. Authored under TASK-357. Substituted by skills/llm-wiki-init/scripts/init-node.ts. -->
---
node: /Users/vedmalex/work/statemachine/packages/statemachine/.llm-wiki
updated: 2026-06-15T07:21:53.810Z
---

# Sources — .llm-wiki

Source/provenance registry. One row per ingested source. Append-only.

link_mode values: `symlink` | `move` | `copy`
Extractor values: `none` or extractor script name relative to `.extractors/` or `extractors/`.
Source ID: stable slug derived from basename + ingest date (e.g., `task-001-2026-05-18`).
Source hash: SHA-256 first 12 hex chars of file content (or recursive hash for dirs).
Original path: absolute pre-ingest location (preserved after move for audit/recovery).

Optional git columns (UR-040, tech-spec §24.19): when the source resolves inside a
git repository at ingest time, link-source.ts appends three trailing columns
to the row — `git_head_sha`, `git_branch`, `git_last_commit_date` — used by
re-ingest drift detection and the `code.*` lint rules. Rows without these
columns remain valid (backward-compatible).

Freshness columns (TASK-358 §3): six trailing columns added by change-detector.ts:
`last_checked_at`, `freshness_status`, `last_change_detected_at`, `source_mtime`,
`http_last_modified`, `http_etag`. Rows with 7, 11, or 17 columns are all valid.
See `skills/llm-wiki-maintain/references/sources-md-schema.md` for full schema reference.

| Source ID | Type | Path in raw/ | Original path | link_mode | Source hash | Ingested | Extractor (if any) | git_head_sha (opt) | git_branch (opt) | git_last_commit_date (opt) | last_checked_at | freshness_status | last_change_detected_at | source_mtime | http_last_modified | http_etag |
|-----------|------|--------------|---------------|-----------|-------------|----------|--------------------|--------------------|------------------|----------------------------|-----------------|------------------|-------------------------|--------------|--------------------|-----------|
| (empty — populated by llm-wiki-ingest) | — | — | — | — | — | — | — | — | — | — |  |  |  |  |  |  |
| regions-and-parallel | file | raw/regions-and-parallel.md | /Users/vedmalex/work/statemachine/packages/statemachine/docs/regions-and-parallel.md | symlink | 13e310de0f73 | 2026-06-15T07:22:09.806Z |  | f8f99fc3368bf780f268a5307fcabd03942d63a7 | fix/regions-ancestor-entry-and-final-join | 2026-06-15T10:17:12+03:00 |   |  |  |  |  |  |
| README | file | raw/README.md | /Users/vedmalex/work/statemachine/packages/statemachine/README.md | symlink | a98de350e0b2 | 2026-06-15T07:22:09.857Z |  | f8f99fc3368bf780f268a5307fcabd03942d63a7 | fix/regions-ancestor-entry-and-final-join | 2026-06-15T10:17:12+03:00 |   |  |  |  |  |  |
| hierarchical.test | file | raw/hierarchical.test.ts | /Users/vedmalex/work/statemachine/packages/statemachine/src/tests/hierarchical.test.ts | symlink | f9ec5ed0fd3d | 2026-06-15T07:22:09.896Z |  | f8f99fc3368bf780f268a5307fcabd03942d63a7 | fix/regions-ancestor-entry-and-final-join | 2026-06-15T10:03:31+03:00 |   |  |  |  |  |  |
