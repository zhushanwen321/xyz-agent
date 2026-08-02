---
"@zhushanwen/pi-subagent-workflow": minor
---

Add worktree support and returnMeta mode to workflow agent() calls.

- **W1 — worktree support for `agent()` calls**: subagent-service and worker-script-builder now accept a `worktree` option, allowing workflow-spawned agents to run in dedicated git worktrees instead of the main worktree.
- **W2 — `returnMeta` mode**: a new execution mode that returns `worktreePath` and `sessionFile` metadata from spawned subagents, so parent workflows can reference the child's worktree and session.
