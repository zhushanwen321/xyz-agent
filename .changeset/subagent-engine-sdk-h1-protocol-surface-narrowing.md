---
'@zhushanwen/subagent-engine-sdk': minor
---

Protocol surface narrowing aligned with the chat-run unification ([H1]) and the subagent service decomposition ([H3]). Breaking changes to the wire protocol and published types — hosts and engines MUST be upgraded in lockstep with `@zhushanwen/subagent-core` in the same release batch (old-protocol engines paired with new-core `resume` runs would silently lose session continuity: each round would spawn a fresh session file and overwrite the previous one).

- **`interact` method family removed** (protocol methods 10 → 9): chat continuity is unified into the `run` method — a continuation round is a new run carrying a `resume` anchor (design: subagent-chat-run-unification §3.3 D5/D7, units U5/U6). `InteractAction` / `InteractResult` contract types are removed with it.
- **`RunChatParams` renamed to `RunResumeParams`** and the run session-form key switched from `chat` to `resume` (read/write sides switched in the same batch, no dual-key window; payload shape unchanged: `recordId` + optional `ResumeAnchor`).
- **Reverse channel family narrowed** (9 → 8): the `host/roundLifecycle` phase channel is retired — per-round phase frames and the recordId-keyed routing died with the chat-domain phase machine; streaming deltas flow through `host/streamDelta` (runId-keyed run-scoped channel).
- `HostStreamDeltaParams` comment semantics corrected: the recordId-association branch is a legacy v1.x engine compatibility payload, not a current-write shape.
