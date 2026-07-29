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
| regions-and-parallel | file | raw/regions-and-parallel.md | /Users/vedmalex/work/statemachine/packages/statemachine/docs/regions-and-parallel.md | symlink | 13e310de0f73 | 2026-06-15T07:22:09.806Z |  |  25963eb467cbcca46451bb7c792a21c1e9e14e6e  | fix/regions-ancestor-entry-and-final-join | 2026-06-15T10:17:12+03:00 |  2026-07-29T02:07:25.468Z  |  fresh  |  |  |  |  |  |
| README | file | raw/README.md | /Users/vedmalex/work/statemachine/packages/statemachine/README.md | symlink | c6c5258aad4a | 2026-06-15T07:22:09.857Z |  |  25963eb467cbcca46451bb7c792a21c1e9e14e6e  | remediation/w1-prep | 2026-06-15T10:17:12+03:00 |  2026-07-29T02:07:25.468Z  |  2026-07-29T02:09:46.975Z  |  fresh  |    |  |  |  |
| hierarchical.test | file | raw/hierarchical.test.ts | /Users/vedmalex/work/statemachine/packages/statemachine/src/tests/hierarchical.test.ts | symlink | 984798c45929 | 2026-06-15T07:22:09.896Z |  |  25963eb467cbcca46451bb7c792a21c1e9e14e6e  | remediation/w1-prep | 2026-06-15T10:03:31+03:00 |  2026-07-29T02:07:25.468Z  |  2026-07-29T02:09:46.975Z  |  fresh  |    |  |  |  |
