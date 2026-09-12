---
'@zhushanwen/zcode-subagent-cli': patch
---

Protocol alignment with the engine-sdk chat-run unification: continuation rounds are dispatched as session-form runs keyed by `run.resume` (the legacy `chat` key is retired from the wire contract the engine consumes). No breaking public API surface change — one additive internal refactor: the module-private failed-terminal-status predicate was consolidated as an exported `isFailedTerminalStatus` in `constants.ts` (package-internal consumers only; not re-exported from the package entry, so the public entry surface is unchanged). Behavior is unchanged for same-version host/engine pairs. Pair with a `@zhushanwen/subagent-core` bump from the same release batch to avoid old-protocol/new-core resume mismatches.
