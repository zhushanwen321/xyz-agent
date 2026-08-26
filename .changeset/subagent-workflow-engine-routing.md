---
'@zhushanwen/pi-subagent-workflow': minor
---

**subagent-workflow: engine-neutral core with zcode engine support**

- Subagent execution is now engine-neutral: an engine registry with 3-tier routing (explicit request → configured default → guarded fallback) picks the engine per task, with engine provenance recorded on every execution record
- New `zcode` engine runs subagents through a single-shot zcode CLI adapter (launcher / parser / preparer / reader); pi remains the default engine with unchanged behavior
- Shared degradation layer (schema emulation, kill-chain, event journal, persona router, nesting guard, pool manager) applies uniformly across engines
- zcode credentials now use v2-only discovery — the legacy `~/.zcode/cli/config.json` dependency is removed
- Extension data-dir layout for engines is standardized via a shared `engine/paths.ts` SSOT used by both the extension writer and the runtime validator
