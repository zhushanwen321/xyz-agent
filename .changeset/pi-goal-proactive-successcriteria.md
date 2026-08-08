---
"@zhushanwen/pi-goal": minor
---

Flip `goal_control` create to proactive + add `successCriteria` field.

## What's New

- **create → proactive**: `goal_control` create now proactively starts goals for complex multi-step work (3+ steps, multi-file, needs completion verification), instead of only when the user explicitly asks. The agent restates the real objective (not a literal echo) and defines checkable success criteria. 3-tier proactive signal via description + promptSnippet + promptGuidelines.
- **`successCriteria` field**: goals now carry verifiable completion criteria alongside the objective, persisted in `GoalRuntimeState` (optional, backward-compatible). Injected into all steering prompts (contextInjection / continuation / budgetLimit) — `complete` evidence must meet every `successCriteria` condition. Surfaced in TUI widget + RPC GUI + `/goal status`.

## Breaking changes

- `goal_control(action="create")` now **requires** `successCriteria` (handleCreate throws if missing). External `__goalInit` callers keep it optional (programmatic callers).
