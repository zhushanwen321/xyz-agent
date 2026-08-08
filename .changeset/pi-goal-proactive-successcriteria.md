---
"@zhushanwen/pi-goal": minor
"@zhushanwen/pi-plan": patch
---

Flip `goal_control` create to proactive + add `successCriteria` field.

## What's New

- **create → proactive**: `goal_control` create now proactively starts goals for complex multi-step work (3+ steps, multi-file, needs completion verification), instead of only when the user explicitly asks. The agent restates the real objective (not a literal echo) and defines checkable success criteria. 3-tier proactive signal via description + promptSnippet + promptGuidelines.
- **`successCriteria` field**: goals now carry verifiable completion criteria alongside the objective, persisted in `GoalRuntimeState` (optional, backward-compatible). Injected into all steering prompts (contextInjection / continuation / budgetLimit) — `complete` evidence must meet every `successCriteria` condition. Surfaced in TUI widget + RPC GUI + `/goal status`.
- **`/goal update` keeps criteria**: reshape no longer wipes `successCriteria` — pass `--criteria <text>` to replace it, otherwise the previous criteria are kept (with an objectiveUpdated steering note that completion is judged against the new objective). Previously the criteria were silently lost with no way to restore them.
- **plan → goal bridge**: `__goalInit` calls from the plan extension now pass a `slug` (derived from the plan file stem) and a `successCriteria` (all plan steps executed and verified), so plan-initiated goals carry verification standards instead of none.

## Breaking changes

- `goal_control(action="create")` now **requires** `successCriteria` (handleCreate throws if missing). External `__goalInit` callers keep it optional (programmatic callers).
- `@zhushanwen/pi-plan` adds `@zhushanwen/pi-goal` as a peerDependency (type-only import of `GoalInitFn` — runtime unaffected when goal is absent).
