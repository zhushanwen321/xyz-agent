---
"@zhushanwen/pi-subagent-workflow": major
---

v4 one-shot lifecycle convergence for background and conversation-mode subagents — BREAKING major bump:

- **BREAKING — one-shot lifecycle: remove pause/resume across the workflow tool, /workflows command, and session lifecycle**

  Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.

  1. **`workflow` tool action enum narrows to `run`/`status`/`abort`.** Calls with `{"action":"pause"}` / `{"action":"resume"}` now fail pi schema validation with `Validation failed for tool "workflow"` (structured error listing the allowed enum — self-correctable by switching to abort or starting a new run).
  2. **`/workflows` command verbs narrow to `abort`.** `/workflows pause|resume <runId>` no longer pauses/resumes; both verbs now return the removed-capability hint `Workflow <verb> has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>` (warning level). Command completion no longer offers pause/resume; the TUI `p` keybinding is removed (`a` abort remains).
  3. **Session switch/shutdown now terminates running runs as `done,failed`** (previously auto-paused and resumable). Each terminated run persists `state.error = "Session switched: run terminated"` / `"Session shutdown: run terminated"`; token spend on terminated runs is forfeited and resume is unreachable in any form — start a new run instead.

  Behavior notes (non-breaking): on worker crash the runtime rebuild (up to 3 retries, unchanged) discards in-flight agent calls that the old runtime aborted (they re-run fresh), while genuinely-done calls keep their replay cache — a completed step is not re-billed after a crash. Verified in real-pi E2E: after a mid-flight crash the alpha call replayed from cache (exactly 1 subagent session file) and beta re-ran fresh (2 session files).

- **BREAKING — type narrowing: RunStatus two states, snapshot wf-run-v2, create-as-running**

  **Run snapshot format bumps `wf-run-v1` → `wf-run-v2`.** Old v1 snapshot files are silently skipped on load (accepted boundary per design D-5) — runs persisted by previous versions disappear from the run list after upgrade. The state machine is now two-state (`running → done`, `done` the only terminal state): the `paused` status and the `meta.pausedAt` field are gone, runs are created directly as `running` (the transient paused construction step no longer exists), and `ReleaseMode` narrows to `"terminal"`.

- **BREAKING — ExecutionStatus collapsed to two states** (`running` / `closed`). The former `done` / `failed` / `crashed` terminal states and the short-lived `idle` state are merged into `closed`, with the L2 reason carried by the new `closedReason` field (`parent-shutdown` / `parent-fork` / `parent-new` / `user-close` / `cancelled` / `gc`). Consumers that switch on the old status enum in `list` responses or tool details must be updated. Legacy-data display note: the companion xyz-agent release flips `normalizeSubagentStatus`'s unknown-value fallback from `running` to `closed`, so `idle` list items persisted by 7.3.x extensions (conversation-mode subagents waiting for a follow-up) now display as closed/done instead of a perpetual spinner when an old session is reopened.

- **Conversation mode now sustains multiple rounds.** New `message` and `close` tool actions let the parent agent keep chatting with a conversation-mode subagent (`start` with `conversation: true`) across rounds, close it after a round, or auto-upgrade a finished one-shot subagent by sending it a first message.

- **BREAKING — bg-notify payload contract change.** `subagent-bg-notify` records now carry `status: "running"` (a conversation round finished, result included, `round` counter used for dedup) or `"closed"` (terminal, reason in `closedReason`); the legacy `done` / `failed` / `cancelled` values are no longer emitted, and `closedReason` / `round` are new fields. This is a cross-process wire contract — xyz-agent itself consumes it and ships a matching `@xyz-agent/shared` parser in the same release; other consumers of the notify details must align.

- **Recursion guardrails for nested subagents.** The `subagent` tool description now documents tree-shaped task criteria, self-contained task requirements, independent acceptance criteria per level, depth-as-safety-rail positioning (not a budget), and fork cost warnings, preventing LLMs from treating the 10-level cap as encouragement for deep nesting.
