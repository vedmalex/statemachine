# Claude Instructions

<!-- LLM_WIKI_MANAGED_START -->
## LLM-Wiki

This project contains an LLM-Wiki at `.llm-wiki`. See [AGENTS.md](./AGENTS.md) section "LLM-Wiki" or the wiki node's own [AGENTS.md](.llm-wiki/AGENTS.md) for operating instructions.

For any wiki operation, invoke the `llm-wiki-router` skill — do not call internal llm-wiki-* specialists directly. Scripts refuse to run (exit 1) unless invoked via the router (which sets `LLM_WIKI_VIA_ROUTER=1`) or with `--allow-direct-invocation` flag (debug/CI only).

<!-- LLM_WIKI_MANAGED_END -->
