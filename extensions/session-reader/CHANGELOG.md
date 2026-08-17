# @zhushanwen/pi-session-reader

## 0.2.1

### Patch Changes

- a769aea2f: Accept `wf-run-v2` workflow snapshots written by `@zhushanwen/pi-subagent-workflow` 8.x (one-shot lifecycle):

  - **Workflow discovery and overview now read v2 runs.** The sibling extension bumped its run snapshot format from `wf-run-v1` to `wf-run-v2`; until this patch, session-reader's version guards only accepted v1, so `family`/`workflows` discovery silently returned an empty `calls` list for every v2 run (all agent call session file references lost) and the `workflow` overview action returned no result for them. The v2 reading surface is shape-compatible with v1 — `state.calls[].sessionFile` / `result.sessionFile` are unchanged — so only the version literals were widened (`extractCallSessionFiles` NEW branch and `parseRunSnapshot` NEW branch), and `WorkflowOverview.version` now reports `'wf-run-v2'` for v2 snapshots. Legacy no-`v` (`callCache`) snapshots keep the existing best-effort parsing; future formats (e.g. a hypothetical `wf-run-v3`) still parse as null until explicitly evaluated.

## 0.2.0

### Minor Changes

- 4f6e24f45: Add nested execution tree reading and workflow/session record discovery

  - `session-reader`: resolveSessionId now supports three forms (sessionId, taskId/runId, subagent slug), builds nested execution trees via parentRecordId (family mode), discovers workflow runs, enriches SubagentRef records with agent name and manifest/parent fallbacks, and adds find-by-task/slug/agentName matching with source filtering.
  - `subagent-workflow`: persist parentRecordId in the subagent manifest so session-reader can reconstruct the nested execution tree.

## 0.1.0

### Minor Changes

- bc336c3b5: 首次发布：pi session 读取能力扩展包

  - **M1 core**: parser/turns/tree/render/family 纯逻辑核（turns 渲染、family 索引跨代 subagent 关联），零 pi 依赖
  - **M2 discovery**: roots + find（agentDir 注入、first-line scan）+ subagents 子进程会话发现
  - **M3 tool-adapter**: 注册 `session_read` tool（tool-handler 支持 outline/expand/detail/search/extract/export/family 八种读取模式）
  - **M4 TUI**: `#` autocomplete provider（hash 前缀唯一化）+ `/session-pick` 命令（当前 cwd 范围弹窗）
  - **M5 验收记录**: V1-V6 状态记录于 design.md §4.1
  - **v2 优化**: O1 outline assistantBrief/toolSummary、O2 typed toolResult summary、O3 detail 默认 summary、O4 extract action（user-messages/commands/files/commits/tool-results）、O5 hash 冲突唯一前缀（全局 session id set）

## 0.1.0 (unreleased)

- M1: core 纯逻辑核（parser/turns/tree/render/family），零 pi 依赖。
