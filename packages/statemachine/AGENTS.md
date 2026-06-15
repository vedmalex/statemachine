# AGENTS.md

This file documents how AI agents should work in this directory.

<!-- LLM_WIKI_MANAGED_START -->
## LLM-Wiki

This project contains an LLM-Wiki at `.llm-wiki` (absolute: `/Users/vedmalex/work/statemachine/packages/statemachine/.llm-wiki`).

- **Entry point:** invoke the `llm-wiki-router` skill for ANY wiki operation (create, populate, lint, query, extract).
- **DO NOT** call internal `llm-wiki-{init,ingest,maintain,query,extract}` skills directly — they expect parameters pre-resolved by router intake interview.
- **Node name:** `.llm-wiki`
- **Created:** `2026-06-15T07:21:53.810Z`
- **Language:** `en`
- **Default link-mode:** `symlink`

For full wiki-node operating instructions, see `.llm-wiki/AGENTS.md`.

### Wiki Access Policy (skill-managed; do not edit)

**To interact with this wiki:**
- ✓ Invoke the `llm-wiki-router` skill (handles intake, then delegates to the right specialist).
- ❌ Do NOT call `llm-wiki-{init,ingest,maintain,query,extract}` skills directly — they refuse to run.
- ❌ Do NOT write files into `.llm-wiki/` (or its subpath like `.llm-wiki/raw/`) with direct file-write tools — this breaks `sources.md` provenance, `link-mode` policy, and `index.md` consistency. Always go through `llm-wiki-router` → `llm-wiki-ingest`.
- ❌ Do NOT run `bun .../init-node.ts` / `link-source.ts` / `lint-node.ts` / `registry-update.ts` directly — they exit 1 without `LLM_WIKI_VIA_ROUTER=1` env or `--allow-direct-invocation` flag.

<!-- LLM_WIKI_MANAGED_END -->
