# Subagent/Workflow 管理面板 — 设计 Spec

> 状态：已定稿（2026-07-12）
> 视觉原型：[draft-subagent-panel.html](./draft-subagent-panel.html)
> icon 候选：[icon-options.html](./icon-options.html)（选中 A · Bot）

## 1. 概述

在左侧边栏新增 **Agents** 和 **Flows** 两个 tab，与现有的会话/文件 tab 同级。用户可以查看当前 session 派生的 subagent 和 workflow 运行状态，点击列表项在主 Panel 中查看完整对话流（与主 agent 对话流同构），关闭后重开仍可查看历史。

### 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 入口位置 | 左侧边栏 SegmentedTab | 导航性质内容放侧边栏，与会话/文件同级；SideDrawer 回归纯辅助视图（terminal/git/doc） |
| 详情展示 | 主 Panel 切换 | SideDrawer 宽度不足（~380px）渲染完整对话流；Panel 切换复用 MessageStream 组件，空间充足 |
| 数据获取 | runtime 直读 JSONL（方案 B） | subagent JSONL 是 pi 原生 session 格式，非扩展私有格式；不依赖扩展适配，关闭重开可重建 |
| 实时 streaming | fs.watch JSONL 增量解析 | message 级刷新（每条 assistant 消息完成后出现），非逐字；足够用于后台任务监控 |
| 操作方式 | 列表项直接操作按钮 | cancel/pause/resume/abort 通过 `prompt("/workflows abort <runId>")` 触发，经 pi slash command 分发，不经 LLM |
| workflow 导航 | 两层独立视图 + 第三层 Panel | 列表 → phase 详情（sidebar 内）→ agent call 对话流（Panel 切换） |

## 2. SegmentedTab 变更

### 现状

```
[会话 6] [文件 4]
```

### 变更后

```
[💬 6] [📄 4] [🤖 2] [⚡ 1]
         icon-only，等宽均分，label 收进 title
```

| tab | icon | label | 含义 |
|-----|------|-------|------|
| sessions | MessageSquare | 会话 | 现有，不变 |
| files | File | 文件 | 现有，不变 |
| subagents | **Bot**（lucide） | Agents | 新增，后台 subagent 列表 |
| workflows | **Workflow**（lucide） | Flows | 新增，workflow run 列表 |

### SegmentedTab 视觉规范

- **icon-only**：4 个 tab 等宽均分（`flex: 1`），只显示 icon + count 数字
- **label 收进 title**：hover 显示完整名称
- **icon 尺寸**：15px
- **count**：font-mono 9.5px，active 态 accent 色
- **badge-dot**：活跃任务时右上角绝对定位蓝点（6px），不占布局空间
- **active 态**：`border-border-strong` + `bg-accent-soft` + `text-accent`

### Bot icon SVG

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="8" width="16" height="12" rx="2"/>
  <path d="M12 2v6"/>
  <circle cx="9" cy="14" r="1"/>
  <circle cx="15" cy="14" r="1"/>
  <path d="M9 18h6"/>
  <path d="M2 14h2"/>
  <path d="M20 14h2"/>
</svg>
```

方头 + 天线 + 双眼 + 嘴 + 侧耳，机器人语义清晰。

## 3. 页面结构

### 3.1 整体布局

```
┌─ Sidebar (340px) ────────┬─ Main Panel (flex-1) ──────────┐
│ Brand                    │ PanelHeader                     │
│ 新建任务 / 搜索           │   ← 返回主会话 | spinner | 名称  │
│ 概览                      │─────────────────────────────────│
│ [💬][📄][🤖][⚡]          │ MessageStream                   │
│                          │   (主对话流 / subagent 对话流)   │
│ 子视图区：                 │                                 │
│   sessions → SessionList  │                                 │
│   files    → FileView     │                                 │
│   subagents→ SubagentList │                                 │
│   workflows→ WorkflowList │                                 │
│                          │─────────────────────────────────│
│ 用户区                    │ Composer                        │
└──────────────────────────┴─────────────────────────────────┘
```

### 3.2 子视图区路由

```typescript
// stores/sidebar.ts
export type SidebarTab = 'sessions' | 'files' | 'subagents' | 'workflows'
```

```vue
<!-- Sidebar.vue 子视图区 -->
<template v-if="sidebar.activeTab === 'sessions'">
  <SessionList ... />
</template>
<template v-else-if="sidebar.activeTab === 'files'">
  <FileView ... />
</template>
<template v-else-if="sidebar.activeTab === 'subagents'">
  <SubagentList :session-id="focusedSessionId" @select="onSelectSubagent" />
</template>
<template v-else-if="sidebar.activeTab === 'workflows'">
  <WorkflowList :session-id="focusedSessionId" @select="onSelectAgentCall" />
</template>
```

## 4. Agents Tab — Subagent 列表

### 4.1 列表项结构

```
┌────────────────────────────────────────────┐
│ [spinner] JWT 调研  bg-jwt-research  [Cancel]│
│            3 turns · 2.1k tok · 45s         │
│            调研 JWT vs session 最佳实践      │
└────────────────────────────────────────────┘
```

| 区域 | 内容 | 样式 |
|------|------|------|
| 状态指示 | spinner（running）/ 绿点（done）/ 红点（failed）/ 灰点（cancelled） | 13px spinner / 8px dot |
| 名称 | agent 名称 + slug | 12.5px font-medium，slug 用 mono 10.5px subtle |
| 操作按钮 | Cancel（仅 running 态显示） | hover 出现，22px ghost button，danger 色 |
| 摘要 | turns · tokens · elapsed | mono 10px subtle |
| 任务描述 | task 文本 | 11px muted，1 行 truncate |

### 4.2 列表项交互

- **点击卡片** → 主 Panel 切换为该 subagent 的对话流
- **hover** → 右侧出现操作按钮（Cancel）
- **Cancel 按钮** → `prompt("/subagents cancel <recordId>")` → 状态变为 cancelled

### 4.3 空态

```
   [🤖 icon, 28px, subtle opacity 0.4]
   暂无后台任务
   发起 background subagent 后在此查看进度
```

## 5. Flows Tab — Workflow 列表

### 5.1 视图 1：Workflow 列表

```
┌────────────────────────────────────────────┐
│ [spinner] 部署流程  deploy-flow   [Pause][Abort]│
│            ▓▓▓▓▓▓▓▓▓▓░░░░░  66%             │
│            1m20s · 12k tok                   │
└────────────────────────────────────────────┘
```

| 区域 | 内容 | 样式 |
|------|------|------|
| 状态指示 | spinner（running）/ 黄点（paused）/ 绿点（done）/ 红点（failed/aborted） | 同 subagent |
| 名称 | workflow 名称 + slug | 同 subagent |
| 操作按钮 | Pause + Abort（running）/ Resume + Abort（paused） | hover 出现 |
| 进度条 | phase 完成比例 | 3px 高，accent 色，done 态 success 色 |
| 摘要 | elapsed · tokens | mono 10px subtle |

### 5.2 视图 2：Workflow 详情（phase 列表）

点击 workflow 卡片进入视图 2。

```
← 返回  部署流程                    [Pause][Abort]

● PHASE 1: BUILD          2 agents · 45s
  [user] builder  step-3.7-flash     3k tok · 2 tools · 22s  [✓]
  [user] linter   step-3.7-flash     1.2k tok · 1 tool · 8s   [✓]

● PHASE 2: TEST           1 agent · running
  [user] tester   step-3.7-flash     1.8k tok · 3 tools · 15s [spinner]

○ PHASE 3: DEPLOY         pending
  [user] deployer step-3.7-flash     等待 phase 2 完成        (灰显)
```

| 区域 | 内容 | 样式 |
|------|------|------|
| 返回按钮 | ← 返回 + workflow 名称 + 操作按钮 | 12px，hover accent |
| phase header | phase dot + 名称 + agent 数/耗时 | 10.5px uppercase tracked subtle |
| phase dot | done=绿 / running=蓝 / pending=灰(opacity 0.4) | 6px |
| agent call | user icon + 名称 + model + 摘要 + 状态 | 卡片式，hover 高亮 |
| pending agent | opacity 0.4 | 不可点击 |

### 5.3 视图切换

- **视图 1 → 视图 2**：点击 workflow 卡片
- **视图 2 → 视图 1**：点击「← 返回」
- **视图 2 → Panel 切换**：点击 agent call → 主 Panel 显示该 agent call 的对话流

### 5.4 agent call 交互

- **点击 agent call** → 主 Panel 切换为该 agent call 的对话流
- PanelHeader 显示「← 返回主会话」+ agent 名称 + `slug: workflow · phase: test`
- 终态 agent call（done/failed）的对话流可查看完整历史
- 运行中 agent call 的对话流实时更新（fs.watch JSONL）

## 6. Panel 切换机制

### 6.1 状态管理

```typescript
// 新增 store 或 composable
interface SubagentViewState {
  /** 当前是否在查看 subagent/agent call 对话流 */
  viewingSubagent: boolean
  /** 原始 session ID（返回时恢复） */
  originalSessionId: string | null
  /** 当前查看的 subagent/agent call 虚拟 session ID */
  subagentSessionId: string | null
}

// 虚拟 session ID 格式
// subagent:  `subagent:<recordId>`
// agent call: `agent:<runId>:<nodeId>`
```

### 6.2 切换流程

```
用户点击 subagent 卡片
  → useSubagents.selectSubagent(recordId)
  → 保存 originalSessionId
  → Panel sessionId 临时切换为 `subagent:<recordId>`
  → chatStore.messages.get(`subagent:<recordId>`)
    ├─ 已有缓存 → 直接渲染
    └─ 无缓存 → RPC session.getSubagentHistory(recordId)
       → 读 JSONL 重建 Message[] → chatStore.messages.set(...)
       → MessageStream 渲染
  → PanelHeader 显示「← 返回主会话」+ subagent 名称

用户点击「← 返回主会话」
  → Panel sessionId 恢复为 originalSessionId
  → subagent 消息保留在 chatStore（切回时不需要重新加载）
```

### 6.3 PanelHeader 变体

**正常态**（主对话流）：
```
[spinner] dir › branch                    [git] [drawer]
```

**subagent 查看态**：
```
[← 返回主会话] [spinner] subagent-name  slug
```

- 隐藏 split/新建/关闭按钮（虚拟 session 不支持分屏）
- 隐藏 git 按钮（subagent 无 git 上下文）
- 隐藏 drawer-toggle（subagent 对话流不需要 SideDrawer）

## 7. 数据流架构

### 7.1 runtime 侧

```
┌─ runtime ──────────────────────────────────────────────────────┐
│                                                                │
│  SubagentWatcher（新增）                                       │
│    监听目录：<dataDir>/pi/agent/subagents/<encodedCwd>/         │
│    ├─ 扫描 sessions/*.jsonl                                    │
│    │  → 解析 identity custom entry                             │
│    │  → 产出 SubagentRecord[]（id/agent/status/task/...）      │
│    │  → 按 rootSessionId 过滤（只显示当前 session 的）          │
│    ├─ WS 推 subagent.list（session 切换 + 状态变化时）          │
│    └─ fs.watch 活跃 JSONL → 增量解析新行                       │
│       → WS 推 subagent.message（单条 Message 增量）             │
│                                                                │
│  WorkflowWatcher（新增）                                       │
│    监听目录：<dataDir>/pi/agent/workflow-state/                │
│    ├─ 解析 *.jsonl run 快照 → WorkflowRun[]                    │
│    │  → 按 session entries 中的 workflow-state-link 过滤       │
│    └─ WS 推 workflow.list + workflow.update                    │
│                                                                │
│  新增 RPC:                                                     │
│    session.getSubagents(sessionId) → SubagentRecord[]          │
│    session.getSubagentHistory(recordId) → Message[]            │
│    session.getWorkflows(sessionId) → WorkflowRun[]             │
│    session.getAgentCallHistory(runId, nodeId) → Message[]      │
│                                                                │
│  操作（复用 prompt 通道，不经 LLM）:                            │
│    client.prompt("/subagents cancel <recordId>")               │
│    client.prompt("/workflows pause <runId>")                   │
│    client.prompt("/workflows resume <runId>")                  │
│    client.prompt("/workflows abort <runId>")                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 7.2 renderer 侧

```
┌─ renderer ─────────────────────────────────────────────────────┐
│                                                                │
│  useSubagents(sessionId) composable（新增）                    │
│    ├─ 订阅 subagent.list → ref<SubagentRecord[]>               │
│    ├─ 订阅 subagent.message → chatStore.messages.set(           │
│    │    `subagent:${recordId}`, [...msgs])                     │
│    └─ selectSubagent(recordId) → 切换 Panel sessionId           │
│                                                                │
│  useWorkflows(sessionId) composable（新增）                    │
│    ├─ 订阅 workflow.list → ref<WorkflowRun[]>                  │
│    ├─ 订阅 workflow.update → 更新对应 run                       │
│    └─ selectAgentCall(runId, nodeId) → 切换 Panel sessionId     │
│                                                                │
│  chatStore（复用）                                             │
│    messages.set(`subagent:<id>`, Message[])                    │
│    ← MessageStream 直接消费，无需新组件                         │
│                                                                │
│  SubagentList.vue（新增）                                      │
│    渲染 useSubagents 列表，点击 → selectSubagent                │
│                                                                │
│  WorkflowList.vue（新增）                                      │
│    视图 1: workflow 卡片列表，点击 → 进入视图 2                 │
│    视图 2: phase + agent call 列表，点击 → selectAgentCall      │
│                                                                │
│  Panel / MessageStream（复用，不改）                           │
│    sessionId 临时切换为虚拟 session → 渲染 subagent 对话流      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 7.3 JSONL → Message 转换

subagent 的 JSONL 是 pi 原生 session 格式，与主 session 同构：

```jsonl
{"type":"session","id":"...","cwd":"..."}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"toolCall","id":"...","name":"read","arguments":{...}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"...","toolName":"read","content":[...]}}
{"type":"custom","customType":"subagent-identity","data":{"id":"...","agent":"...","rootSessionId":"..."}}
```

转换复用 runtime 侧已有的 `session-history.ts` / `message-converter.ts`（处理主 session JSONL → Message 的同套逻辑），只需：
1. 适配 `subagent-identity` custom entry（提取 agent 名称/task 等）
2. 路径推导：`getDataDir() / pi/agent/subagents / encodeCwd(mainCwd) / sessions / *.jsonl`

### 7.4 实时性

| 场景 | 延迟 | 机制 |
|------|------|------|
| subagent 状态变化 | ~1s | fs.watch 目录 → 重扫 JSONL → WS 推 subagent.list |
| subagent 对话流（运行中） | ~1s | fs.watch JSONL 文件 → 增量解析尾部新行 → WS 推 subagent.message |
| subagent 对话流（终态重开） | 即时 | 一次性读 JSONL → reconstruct → Message[] |
| workflow 状态变化 | ~1s | fs.watch workflow-state/*.jsonl → WS 推 workflow.update |
| 操作生效（cancel/pause/abort） | ~2s | prompt → pi slash command → 扩展执行 → fs.watch 检测状态变化 |

**注意**：pi 的 `text_delta` 不写 JSONL（只在 RPC stdout 推）。JSONL 在每条 message 完成时 flush。因此 subagent 面板是 **message 级刷新**（每条 assistant 消息完成后出现），非逐字 streaming。这对后台任务监控足够——用户不需要盯着逐字输出，看到消息逐条出现即可。

## 8. 扩展侧改动

`/subagents` 和 `/workflows` command handler 需要加 RPC 分支，使其在 RPC 模式下直接执行操作（cancel/pause/resume/abort），不调 `ctx.ui.custom()`（RPC 模式返回 undefined）。

### 当前 handler（问题）

```typescript
pi.registerCommand("subagents", {
  handler: async (argsStr, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify("..."); return; }  // RPC 模式 hasUI=true，拦不住
    await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);  // ctx.ui.custom() → undefined
  },
});
```

### 改后 handler

```typescript
pi.registerCommand("subagents", {
  handler: async (argsStr, ctx) => {
    const args = argsStr.trim().split(/\s+/);
    const action = args[0];  // "cancel" | undefined（无参数 = 原列表行为）

    // RPC 模式：直接执行操作，不打开 TUI
    if (ctx.mode === "rpc" && action === "cancel") {
      const recordId = args[1];
      await service.cancel(recordId);
      ctx.ui.notify(`Cancelled subagent ${recordId}`, "info");
      return;
    }

    // TUI 模式：打开列表 overlay（原逻辑不变）
    if (!ctx.hasUI) { ctx.ui.notify("...", "error"); return; }
    await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
  },
});
```

`/workflows` handler 同理，支持 `pause <runId>` / `resume <runId>` / `abort <runId>` 三个 action。

## 9. 状态清单

| 状态 | 列表项展示 | 操作按钮 | Panel 对话流 |
|------|-----------|----------|-------------|
| running | spinner（accent） | Cancel / Pause + Abort | 实时更新（fs.watch） |
| done | 绿点 | 无 | 完整历史（只读） |
| failed | 红点 | 无 | 完整历史（含错误） |
| cancelled | 灰点（opacity 0.5） | 无 | 完整历史（截断处） |
| paused（workflow） | 黄点 | Resume + Abort | 不适用 |
| pending（agent call） | 灰点（opacity 0.4） | 无 | 不可点击 |
| 加载中 | 骨架屏 | 无 | 骨架屏 |

## 10. 新增组件清单

| 组件 | 类型 | 职责 |
|------|------|------|
| `SubagentList.vue` | 展示组件 | Agents tab 列表，渲染 SubagentRecord[] 卡片 |
| `WorkflowList.vue` | 展示组件 | Flows tab，视图 1（workflow 列表）+ 视图 2（phase/agent call） |
| `useSubagents.ts` | composable | 订阅 subagent WS 事件 + selectSubagent |
| `useWorkflows.ts` | composable | 订阅 workflow WS 事件 + selectAgentCall |
| `SubagentWatcher` | runtime service | fs.watch subagent JSONL + WS 推送 |
| `WorkflowWatcher` | runtime service | fs.watch workflow-state JSONL + WS 推送 |

### 复用组件（不改）

| 组件 | 复用方式 |
|------|----------|
| `Panel.vue` | sessionId 临时切换为虚拟 session |
| `MessageStream.vue` | 渲染 subagent 对话流（读 chatStore 虚拟 key） |
| `PanelHeader.vue` | 增加返回按钮变体（已有 toggleDrawer emit 模式） |
| `SegmentedTab.vue` | tabs 数组加 2 项 |
| `chatStore` | messages Map 支持虚拟 session key |
| `session-history.ts` | JSONL → Message 转换（复用，适配路径） |

## 11. 实现优先级

### Phase 1：subagent 列表 + 对话流查看（只读）

- runtime: SubagentWatcher + `session.getSubagents` / `session.getSubagentHistory` RPC
- renderer: `useSubagents` composable + `SubagentList.vue` + Panel 切换
- SidebarTab 加 `subagents` + SegmentedTab 加 Bot icon
- 不含操作按钮、不含实时 streaming（终态一次性加载）

### Phase 2：实时 streaming + 操作按钮

- runtime: fs.watch 活跃 JSONL → `subagent.message` WS 事件
- renderer: `useSubagents` 订阅 message 事件 → chatStore 增量 append
- 扩展: `/subagents cancel` handler 加 RPC 分支
- 列表项加 Cancel 按钮

### Phase 3：workflow 支持

- runtime: WorkflowWatcher + `session.getWorkflows` / `session.getAgentCallHistory` RPC
- renderer: `useWorkflows` composable + `WorkflowList.vue`（视图 1 + 视图 2）
- SidebarTab 加 `workflows` + SegmentedTab 加 Workflow icon
- 扩展: `/workflows pause|resume|abort` handler 加 RPC 分支

## 12. 已知约束

1. **message 级实时**：非逐字 streaming。pi 的 `text_delta` 不写 JSONL，只在 RPC stdout 推。要逐字 streaming 需增加扩展 `onEvent → runtime` 通道（未来增量改进，不推翻已有方案）。

2. **路径推导**：subagent JSONL 路径 `<dataDir>/pi/agent/subagents/<encodedCwd>/sessions/*.jsonl`。`encodeCwd` 逻辑从扩展的 `path-encoding.ts` 复制（简单字符串替换：`"/" → "-"`，加 `--` 前后缀）。

3. **session 隔离**：subagent 按 `rootSessionId` 字段过滤（identity custom entry 中），只显示当前 session 创建的 record。切换 session 时列表刷新。

4. **虚拟 session 生命周期**：subagent 消息注入 `chatStore.messages` 后，切回主对话流时不清除（保留缓存，切回时不需要重新加载）。session 切换时清除（避免内存膨胀）。

5. **Panel 切换不持久化**：subagent 查看态是临时的，关闭 app 重开后恢复到主对话流。subagent 列表和历史可通过 Agents tab 重新访问。

6. **SideDrawer 不变**：SideDrawer 保持现有 5 tab（terminal/browser/git/doc/detail），不新增 subagent/workflow tab。PanelHeader 的 Bot 按钮移除，入口统一走左侧边栏。
