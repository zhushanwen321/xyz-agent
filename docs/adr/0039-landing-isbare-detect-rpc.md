# ADR 0039：Landing 态 isBare 检测改用独立 RPC（解耦 currentSession）

- **状态**：Proposed
- **日期**：2026-07-23
- **关联 topic**：cw-2026-07-23-fix-landing-dir-popover

## 背景

DirSelectPopover 的「新建 worktree…」动作项受 `v-if="isBareWorkspace"` 控制（`DirSelectPopover.vue:222`）。
该 prop 由 `Landing.vue` 从 `flow.gitInfo.value?.isBare` 派生，而 `gitInfo` 依赖
`currentSession.value?.gitBranch`（`useNewTaskFlow.ts:101-105`）。

问题：xyz-agent 采用**统一延迟 create** 架构——landing 态（选目录/选分支阶段）不创建 session，
`currentSession` 恒为 null。因此 `gitInfo` 恒为 null，`isBareWorkspace` 恒为 false，
**「新建 worktree」按钮在 landing 态永不显示**。

该按钮本应服务于「在选目录阶段为 bare repo workspace 新建 worktree」的用例——
但显示条件却寄生在「已建 session」的前提上，形成架构矛盾。

历史归属：`8d7cff0a`（worktree review R1）把 isBare 数据源绑到 `currentSession.gitBranch`；
`7f704f8b`（移除 publicSession）进一步确保 landing 态无任何 session 兜底，矛盾显化。

## 决策

新增 RPC `workspace.detectBare({ cwd })`，前端在 landing 态基于 `pendingCwd`（已选/预填的目录）
查询 isBare，**解耦对 currentSession 的依赖**。

- runtime 侧：`WorkspaceDetector` 已有 `detectBareWorkspace(cwd)`（session 摘要链路复用的
  `detectBareWorkspaceCached` 同源），新 RPC 直接复用，零新增检测逻辑
- 前端侧：landing 态 watch `pendingCwd`，变化时调 RPC 刷新 isBare，驱动按钮显隐
- gitInfo（含 isBare）保留给「已建 session 的分支 chip」等场景，**不删除**——两条数据源并存，
  landing 态用 RPC，session 态继续用 gitInfo

## 替代方案

1. **workspace records 带 isBare 字段**：`record(cwd)` 写入时检测并存入 RecentWorkspaceRecord。
   否决理由：records 是历史快照，`.bare` 后来新增/删除会 stale；且要改 shared 类型 + runtime store + 前端三层。
2. **前端纯路径推断**：前端无法访问文件系统，只能猜，不准（worktree 嵌套层数不定）。
3. **复用 gitInfo + 兜底**：record 不含 isBare 就只能猜 false，治标不治本。

## 后果

- 正面：landing 态 isBare 数据真实（基于实际要打开的目录），与 runtime 同一检测逻辑；
  解耦 session 生命周期，符合延迟 create 架构。
- 负面：新增一个 RPC + handler + 前端 watch 调用；pendingCwd 每次变化触发一次 RPC（频率低，可接受）。
