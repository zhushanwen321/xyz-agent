# ADR-0040：SideDrawer 控制态（isOpen/activeTab/docked）改为 per-session 分区

- **Status**: Accepted
- **Date**: 2026-07-23
- **Topic**: `cw-2026-07-23-sidedrawer-per-session`
- **Supersedes**: 无（是 [ADR-0036](0036-session-isolation-map-partition.md) 在 SideDrawer 控制态上的具体落地）

## Context

`useSideDrawer` 的三个控制态 `isOpen` / `activeTab` / `docked` 是**全局模块级单例 ref**（`useSideDrawer.ts:40-54`），被 10+ 处调用方共享。而 SideDrawer 组件物理上跟随 active panel（`PanelContainer.vue:55 :session-id="activePanelSessionId"`），widget 数据（`SideDrawer.vue` 内 `useSessionScopedState`）也已 per-session。

这个割裂——控制态全局、内容态 per-session——引发两个 bug：

1. **跨 session 干扰**：`openTasksDrawerOnFirstData`（`chat-message-effects.ts:175`）在后台 session 的 todo/goal 首次数据到达时，无 `sid === focusedSessionId` 守卫直接 `useSideDrawer().open('tasks')`，在用户正看着的别的 session 上强行弹开 drawer。
2. **切回不恢复**：drawer 开关态不随 session 记忆。从 A 切走再切回，`isOpen` 是上个 session 残留值，不是 A 该有的状态。没有「该 session 有待打开的 drawer」语义。

ADR-0036 已点名 `SideDrawer.vue` 属 watch 清理派反模式，决策是「迁移到 Map 分区派」。但当时只迁移了 widget 数据态（`drawerState`），**控制态（isOpen/activeTab/docked）仍是全局单例**——本 ADR 补齐这块。

## Decision

SideDrawer 的控制态全部改为 per-session 分区，并给事件驱动打开加 sid 守卫 + 独立 pendingOpen 标记。

### 1. 控制态 per-session 化（用 `useSessionScopedState`）

`isOpen` / `activeTab` / `docked` 从模块级单例 ref 改为 per-session Map 分区。分区键用 `focusedSessionId`（active panel 的 sessionId，`useSidebar.ts:98`），与 SideDrawer 物理挂载归属一致。

```
DrawerControlState = { isOpen: boolean, activeTab: SideDrawerTab, docked: boolean }
Map<sessionId, DrawerControlState>
```

`selectedCommandName` / `detailFilePath` 暂不分区（它们是「打开时的瞬时参数」，消费后即清空，不构成 session 级持久状态；且 Doc/Detail tab 内容已 per-session）。后续若发现跨 session 残留再评估。

### 2. 事件驱动打开加 sid 守卫 + pendingOpen 标记

`openTasksDrawerOnFirstData` 加守卫：`sid !== focusedSessionId.value` 时不直接 `open()`，而是置 `pendingOpen[sid] = true`。用户切回该 session 时（`focusedSessionId` 变化），检查 `pendingOpen` 决定是否打开。

**为什么用独立 pendingOpen 而非复用 per-session isOpen**：用户明确选择显式语义。per-session isOpen 表达「该 session 的 drawer 当前是否开着」，pendingOpen 表达「该 session 有未展示给用户的任务到达事件」——两者职责不同。复用 isOpen 会让「用户手动关了 drawer」与「任务到达想提示」两种语义混淆（手动关闭后切走再切回，是否该重开？pendingOpen 能区分「用户已看过」vs「未看过」）。

### 3. tasks tab 强制 docked 的逻辑收进分区内

现状 `open('tasks')` / `setTab('tasks')` 会全局置 `docked = true`。per-session 化后，这个副作用只在对应 session 分区内生效，不污染其他 session 的 docked 记忆。

## Alternatives Considered

- **只 isOpen per-session，activeTab/docked 全局**（rejected）：切回 A 时可能「drawer 开着却停在 terminal tab」（A 的 tasks 数据触发了打开，tab 却是全局残留），状态不自洽。
- **复用 per-session isOpen 承担 pendingOpen 语义**（rejected）：用户手动关闭与「任务到达待提示」两种语义耦合，行为不可预测。见 Decision §2。

## Consequences

- **正面**：跨 session 干扰根治（事件只记 pendingOpen，不强行弹窗）；切回恢复完整 drawer 形态（isOpen + activeTab + docked）；对齐 ADR-0036，消除 watch 清理派反模式的最后据点之一。
- **正面**：调用方 API 形态不变（仍是 `useSideDrawer().open(...)`），迁移对 10+ 调用方透明——只是底层从单例 ref 变成 per-session 分区。PanelContainer 从「直接解构单例 ref」改为「传 focusedSessionId 给 composable」。
- **负面**：docked 进 Map 后，tasks tab 强制 docked 的全局副作用消失——如果用户在 session A tasks tab（docked=true）切到 session B（docked 记忆=false），B 的 drawer 不再被强制 docked。这是正确行为（docked 本就该 per-session），但与旧全局行为不同，需在测试覆盖。
- **负面**：`resetSideDrawer`（测试隔离用）语义变化——从重置全局单例改为清理所有分区。测试需调整。
