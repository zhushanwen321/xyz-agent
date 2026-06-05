---
pr_created: true
pr_url: https://github.com/zhushanwen321/xyz-agent/pull/69
pr_title: "feat: TUI Bridge Phase 0 — event translation layer"
branch: feat-tui-bridge
---

# PR Evidence

PR created and CI passed.

## PR Details

- **URL:** https://github.com/zhushanwen321/xyz-agent/pull/69
- **Branch:** feat-tui-bridge → main
- **Commits:** 18 (5 implementation + 8 docs/harness + 5 fixes/evidence)

## Implementation Commits

1. `6eb8f978` — feat(protocol): add ServerMessageType values
2. `8332572e` — feat(event-adapter): add FR-1~FR-6 event handlers
3. `08935757` — feat(event-bus): type-harden on/emit/off with ServerMessageType
4. `6044456e` — feat(renderer): add ChatStore fields + useChat handlers
5. `0795812e` — feat(preload): add setTitle type declaration
6. `13b82904` — fix: widen event-bus overloads for backward compat, widen ToolCall.detail type

## CI Fix

Initial CI run had TypeCheck failure (13 TS errors in downstream consumers due to event-bus type hardening). Fixed by:
- Adding `string` overloads with `(msg: any)` for `on/off/emit` — backward compatible
- Widening `ToolCall.detail` from `string` to `string | Record<string, unknown>`

All 3 CI checks pass on second run.
