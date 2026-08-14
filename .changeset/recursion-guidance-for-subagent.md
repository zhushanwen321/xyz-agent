---
"@zhushanwen/pi-subagent-workflow": minor
---

v4 lifecycle convergence for background and conversation-mode subagents:

- **ExecutionStatus collapsed to two states** (`running` / `closed`). The former `done` / `failed` / `crashed` terminal states and the short-lived `idle` state are merged into `closed`, with the L2 reason carried by the new `closedReason` field (`parent-shutdown` / `parent-fork` / `parent-new` / `user-close` / `cancelled` / `gc`). Consumers that switch on the old status enum in `list` responses or tool details must be updated.
- **Conversation mode now sustains multiple rounds.** New `message` and `close` tool actions let the parent agent keep chatting with a conversation-mode subagent (`start` with `conversation: true`) across rounds, close it after a round, or auto-upgrade a finished one-shot subagent by sending it a first message.
- **bg-notify payload contract change.** `subagent-bg-notify` records now carry `status: "running"` (a conversation round finished, result included, `round` counter used for dedup) or `"closed"` (terminal, reason in `closedReason`); the legacy `done` / `failed` / `cancelled` values are no longer emitted, and `closedReason` / `round` are new fields. This is a cross-process wire contract — xyz-agent itself consumes it and ships a matching `@xyz-agent/shared` parser in the same release; other consumers of the notify details must align.
- **Recursion guardrails for nested subagents.** The `subagent` tool description now documents tree-shaped task criteria, self-contained task requirements, independent acceptance criteria per level, depth-as-safety-rail positioning (not a budget), and fork cost warnings, preventing LLMs from treating the 10-level cap as encouragement for deep nesting.
