---
'@zhushanwen/zcode-subagent-cli': patch
---

Protocol alignment with the engine-sdk chat-run unification: continuation rounds are dispatched as session-form runs keyed by `run.resume` (the legacy `chat` key is retired from the wire contract the engine consumes). No public API surface change; behavior is unchanged for same-version host/engine pairs. Pair with a `@zhushanwen/subagent-core` bump from the same release batch to avoid old-protocol/new-core resume mismatches.
