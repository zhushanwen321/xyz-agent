---
verdict: pass
---

# Statusline：Session Strip + Input Toolbar + Global Statusbar

## Background

xyz-agent 当前底部状态栏（AppStatusbar.vue）只显示连接状态、model ID 和 token 数。而 pi 引擎的 extensions（goal/todo/workflow）通过 `ctx.ui.setStatus()` / `ctx.ui.setWidget()` 输出丰富的运行时状态（如 "◆ Goal 3/20 | 2/5 tasks"），但这些数据在 `event-adapter.ts` 第 199-200 行被直接丢弃（`return null`）。

同时，xyz-agent 自己的 plugin 系统（Phase 1-3 已完成）有独立的 `api.ui.updateStatusBarItem()` → `plugin:statusBarUpdate` 通道，但该通道仅支持简单的 `(id, text)` 对，缺少 tooltip/commandId/priority。

**核心问题**：两条数据通道（pi extension setStatus / xyz-agent plugin statusBarUpdate）互不相通，信息零散，用户无法一目了然地看到 session 运行状态。

**视觉 demo**: `docs/designs/views_statusline-v2.html`

### 两套 Extension 系统的关系

```
┌──────────────────────────────────────────────────────┐
│ pi 进程内                                             │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ goal ext     │  │ todo ext     │                  │
│  │ setStatus()  │  │ setStatus()  │                  │
│  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                           │
│         ▼                 ▼                           │
│  RPC extension_ui_request { method: "setStatus" }    │
└──────────────────────┬───────────────────────────────┘
                       │ stdin/stdout
┌──────────────────────▼───────────────────────────────┐
│ xyz-agent Agent Runtime (sidecar)                     │
│                                                       │
│  event-adapter.ts                                     │
│  ├── setStatus → plugin:statusSetUpdate ✅ (本次修复) │
│  ├── setWidget → 暂不处理                             │
│  └── bridge:* → server.ts → plugin-service.ts         │
│                                                       │
│  server.ts                                            │
│  ├── bridge:event → pluginService.handleBridgeEvent() │
│  │               (本次接通，不再只打日志)              │
│  └── plugin:statusSetUpdate → statusline plugin hooks │
│                                                       │
│  plugin-service.ts                                    │
│  ├── handleBridgeEvent() → executeHooks()             │
│  ├── updateStatusBarItem() → WS broadcast             │
│  └── executeHooks() → plugin hooks 串联               │
│                                                       │
│  ┌──────────────────────────────────┐                 │
│  │ statusline built-in plugin (新建) │                 │
│  │ activationEvents: onStartupFinished                  │
│  │ hooks: onExtensionStatusUpdate    │                 │
│  │ → 提取 setStatus 文本 (key+text)  │                 │
│  │ → 查表获取 priority/tooltip       │                 │
│  │ → api.ui.updateStatusBarItem()   │                 │
│  │ → 统一到 plugin:statusBarUpdate  │                 │
│  └──────────────────────────────────┘                 │
└──────────────────────┬───────────────────────────────┘
                       │ WebSocket (唯一前端通道)
┌──────────────────────▼───────────────────────────────┐
│ Frontend                                              │
│  统一监听 plugin:statusBarUpdate                       │
│  ├── InputToolbar.vue  — context, tokens, model       │
│  ├── SessionStrip.vue  — branch, ext chips (per-sess) │
│  └── AppStatusbar.vue  — connection, ext chips (all)  │
└──────────────────────────────────────────────────────┘
```

**关键设计决策**：

1. **唯一前端通道**：前端只监听 `plugin:statusBarUpdate` 一种消息类型。pi extension 的 setStatus 数据通过 statusline plugin 适配后统一走此通道。前端不直接消费 pi 的原始数据。
2. **Plugin 封装**：statusline plugin 作为适配层，接收 event-adapter 翻译后的 setStatus 事件，查表附加 metadata（priority/tooltip），转发为 statusBarUpdate。pi extension 不知道 xyz-agent 的存在。
3. **bridge:event 接通**：同时修复 `server.ts` 中 `bridge:event` 只打日志不调用 `pluginService.handleBridgeEvent()` 的问题，使得 pi 生命周期事件可以触发 plugin hooks。

### statusline plugin 的 key→metadata 映射表

plugin 内置一个静态映射表，为已知 pi extension 的 setStatus key 附加 metadata：

| key (pi extension) | priority | tooltip | scope |
|---|---|---|---|
| `goal` | 10 | "Goal task progress" | per-session |
| `todo` | 20 | "Todo list progress" | per-session |
| `workflow` | 15 | "Workflow status" | per-session |
| `preset` | 30 | "Active preset" | global |
| `ssh` | 40 | "SSH connection" | global |
| `model` | 50 | "Current model" | global |
| *(未知 key)* | 100 | undefined | global |

**scope 字段决定 chip 路由**（见 AC-5 规则）。

## Functional Requirements

### FR-1: Event-adapter 接入 pi extension setStatus

`event-adapter.ts` 不再丢弃 `setStatus` 事件，改为翻译为内部 ServerMessage：

- `setStatus` → `plugin:statusSetUpdate` 消息（遵循冒号命名约定），payload 包含 `{ sessionId, key, text }`
- `setWidget` → 本次不实现，保留 `return null`
- 该消息**不直接广播到前端**，而是由 `server.ts` 路由到 `pluginService`，触发 statusline plugin 的 hooks

同时修复 `server.ts` 中 `bridge:event` case（当前只 `console.log`），改为调用 `pluginService.handleBridgeEvent(eventName, data, sessionId)`。

### FR-2: statusline built-in plugin 封装 pi extension 数据

新建 xyz-agent built-in plugin（`resources/plugins/statusline/`），职责：

- `activationEvents: ['onStartupFinished']`
- 注册 hook 监听 `plugin:statusSetUpdate` 事件
- 提取 setStatus 数据的 `(key, text, sessionId)`
- 查内置映射表获取 `(priority, tooltip, scope)`
- 对未知 key，使用默认值（priority=100, tooltip=undefined, scope=global）
- 通过 `api.ui.updateStatusBarItem(id, text, { tooltip, commandId, priority, scope, sessionId })` 转发到前端

**不做文本解析**：pi extension 的 setStatus 文本直接透传，不做正则匹配或结构化解析。plugin 只附加 metadata，不改变文本内容。

### FR-3: Input Toolbar 组件

在输入框内部底部新增 InputToolbar 组件：

- **Model picker**：显示当前模型 @ provider，点击展开下拉选择。选择新模型后发送 `session.switchModel` 命令到 sidecar → sidecar 通过 pi RPC `set_model` 切换。切换仅影响当前 session 的后续请求，不重启 session。切换失败时恢复原模型显示并显示 toast 错误提示。
- **Thinking level picker**：信号柱图标 + 级别名。可选级别从当前 model 的 `ModelInfo.thinkingLevelMap`（`Record<string, string|null>`）动态读取 keys，不硬编码枚举。`thinkingLevelMap` 为空或 model 无此字段时隐藏 picker。选择新级别后发送 `session.setThinkingLevel` 命令，行为与 model 切换一致（仅影响后续请求，不重启 session）。
- **Context bar**：迷你进度条 + 百分比，颜色三档：<60% accent / 60-85% warning / >85% danger
- **Token stats**：↑input ↓output，单位 auto（<1000 显示数字，≥1000 显示 x.xk）
- **Send button**：发送按钮

数据来源：chatStore（contextUsagePercent, contextInputTokens, contextOutputTokens）、sessionStore（modelId）、modelStore（model 列表 + thinkingLevelMap）

### FR-4: Session Strip 组件

在输入框下方新增 SessionStrip 组件：

- **Branch**：当前 git branch 名称（session 级），数据来自 sessionStore
- **Extension chips**：来自 pluginStore 中 `scope=per-session` 且 `sessionId` 匹配当前 panel 的 statusBarUpdate items（如 goal "◆ 3/20 | 2/5"、todo "4/7"）
- **Cost**：暂不实现。当前 chatStore 没有现成的 cost 字段，pi 也不直接返回费用。待后续 model 定价数据就绪后再加入。此处预留位置（不渲染，不占空间）。

### FR-5: Global Statusbar 重构

重构现有 AppStatusbar.vue：

- **左侧**：连接状态（dot + 文字）+ pi 版本号
- **右侧**：Extension chips — 来自 pluginStore 中 `scope=global` 的 statusBarUpdate items（跨所有 session 汇总，去重）
- 按 priority 排序，有 commandId 的可点击，通过 `pluginStore.executeCommand(pluginId, commandId)` 执行。commandId 的注册和执行机制复用现有 plugin command 系统（Phase 3 已实现）。

### FR-6: Plugin statusBarUpdate 增强

扩展 `api.ui.updateStatusBarItem()` RPC 参数：

- 新增 `tooltip?: string`、`commandId?: string`、`priority?: number`（默认 100）、`scope?: 'per-session' | 'global'`（默认 `'global'`）、`sessionId?: string`
- **向后兼容**：新增参数均为 optional，现有 plugin 调用 `updateStatusBarItem(id, text)` 不传新参数时行为不变（priority=100, scope=global）
- `plugin-service.ts` 维护注册式状态栏 item 管理（Map 存储），每次 updateStatusBarItem 更新对应 item 而非全量广播。变更后广播完整 items 列表到前端。

### FR-7: Built-in Plugin 开发指南

产出文档 `docs/plugin/built-in-plugin-guide.md`：

- 以 statusline plugin 为实际案例
- 覆盖：manifest 结构、activationEvents、hooks 注册、statusBarUpdate API 使用（含新增参数）
- 包含数据流图和代码片段
- 覆盖向后兼容性说明

## Acceptance Criteria

### AC-1: pi extension setStatus 到达前端（端到端）
- [ ] pi goal extension 调用 `ctx.ui.setStatus("goal", "◆ Goal 3/20")` 后，前端在下一个渲染帧内显示对应文本
- [ ] event-adapter 不再丢弃 setStatus 事件，翻译为 `plugin:statusSetUpdate`
- [ ] statusline plugin 收到事件后调用 `updateStatusBarItem()` 转发
- [ ] 前端通过 `plugin:statusBarUpdate` 消息（唯一通道）接收数据

### AC-2: Input Toolbar 完整功能
- [ ] Model picker 显示当前 modelId，点击展开下拉列表，选择后通过 `session.switchModel` 切换
- [ ] Model 切换失败时恢复原模型显示并显示 toast 错误提示
- [ ] Thinking level picker 的可选级别从 `ModelInfo.thinkingLevelMap` 动态读取，不硬编码
- [ ] `thinkingLevelMap` 为空时 picker 自动隐藏
- [ ] Context bar 颜色随 usage 百分比变化：<60% accent, 60-85% warning, >85% danger
- [ ] Token stats 显示 ↑input ↓output

### AC-3: Session Strip 信息展示
- [ ] 显示当前 git branch 名称
- [ ] 仅显示 `scope=per-session` 且 `sessionId` 匹配当前 panel 的 extension status chips
- [ ] split panel 时各 panel 独立显示各自 session 数据

### AC-4: Global Statusbar 聚合
- [ ] 左侧显示连接状态 + pi 版本
- [ ] 右侧仅显示 `scope=global` 的 extension chips，按 priority 排序
- [ ] pi extension setStatus（经 statusline plugin 适配）和 xyz-agent plugin 直接调用的数据同时可见
- [ ] 有 commandId 的 chip 可点击，通过 `pluginStore.executeCommand()` 执行

### AC-5: 信息不重复（chip 路由规则）
- [ ] context bar 和 token stats 仅在 Input Toolbar 显示，Session Strip 和 Global Statusbar 不重复
- [ ] 每个 extension status chip 严格按照 scope 字段路由：
  - `scope=per-session` 且有 sessionId → **Session Strip**（匹配 panel 的 sessionId 时显示）
  - `scope=global` → **Global Statusbar**
  - 不存在同一 chip 同时出现在两处的情况

### AC-6: statusBarUpdate 增强
- [ ] 新增参数（tooltip/commandId/priority/scope/sessionId）均为 optional，不传时行为不变
- [ ] plugin-service 维护注册式 item 管理，updateStatusBarItem 更新对应 item 而非每次全量替换

### AC-7: Built-in Plugin 开发指南
- [ ] `docs/plugin/built-in-plugin-guide.md` 存在且内容完整
- [ ] 以 statusline plugin 为案例覆盖 manifest → activation → hooks → API 全流程

### AC-8: bridge:event 修复
- [ ] `server.ts` 的 `bridge:event` case 调用 `pluginService.handleBridgeEvent()` 而非只打日志
- [ ] pi 生命周期事件（agent_start/agent_end/tool_call 等）能触发已注册的 plugin hooks

## Constraints

- **技术栈**：Vue 3 + Pinia + Tailwind CSS v3 + xyz-ui 组件库
- **设计系统**：遵循 `docs/designs/css_design-system.css` 的 design tokens
- **编码规范**：遵循 `docs/standards.md`，禁止原生 HTML 表单元素、禁止 Emoji、禁止硬编码颜色
- **组件行数**：`<template>` ≤ 400 行, `<script setup>` ≤ 300 行
- **statusline plugin** 是 built-in plugin（`source: 'built-in'`），不可卸载不可禁用
- **pi extension 不可修改**：goal/todo/workflow 等 pi extension 的代码不在本次修改范围内
- **setWidget 不实现**：pi extension 的 `ctx.ui.setWidget()` 暂不接入，保留丢弃
- **Quota bars 不实现**：ZAI/OC/Kimi 等第三方 API 用量信息不在本次范围
- **Cost 暂不实现**：Session Strip 的 cost 字段暂不渲染，待 model 定价数据就绪后加入
- **WS 命名约定**：Server→Client 消息类型使用冒号格式（如 `plugin:statusBarUpdate`），不使用点号

## 业务用例

### UC-1: 用户在 goal 模式下实时查看任务进度
- **Actor**: 使用 xyz-agent 的开发者
- **场景**: 用户通过 `/goal` 启动目标模式，pi goal extension 开始执行多轮任务循环
- **预期结果**: Session Strip 显示该 session 的 goal 进度摘要（如 "◆ 3/20 | 2/5"）；goal 完成后 chip 自动消失（pi extension 调用 `setStatus("goal", undefined)` 清除）

### UC-2: 用户在 split panel 时区分不同 session 状态
- **Actor**: 使用分屏功能的开发者
- **场景**: 用户同时打开两个 panel，分别绑定不同 session（一个在做 goal 任务，一个自由对话）
- **预期结果**: 只有 goal session 的 Session Strip 显示 goal chip；Global Statusbar 不显示 per-session 数据

### UC-3: 用户切换模型和思考级别
- **Actor**: 使用 xyz-agent 的开发者
- **场景**: 用户在输入框点击 model picker 切换到 o3 模型，然后调整 thinking level
- **预期结果**: Input Toolbar 的 model picker 更新为 "o3 @ openai"；thinking level picker 显示 o3 的可选级别（从 `thinkingLevelMap` 动态获取）；切换仅影响后续请求，不重启 session

### UC-4: 插件开发者参考 statusline plugin 编写自己的 built-in plugin
- **Actor**: xyz-agent 插件开发者
- **场景**: 开发者阅读 built-in plugin 开发指南，参考 statusline plugin 的实现模式
- **预期结果**: 开发者能理解 manifest 结构、activation events、hooks 注册、statusBarUpdate API 调用方式（含新增参数），并成功创建自己的 plugin

## Complexity Assessment

**复杂度：中高**

- **前端组件**：3 个新组件（InputToolbar, SessionStrip, 重构 AppStatusbar），每个中等复杂度
- **后端改动**：event-adapter 修复（小）、server.ts bridge:event 接通（小）、plugin-service statusBarItem 管理（中）
- **新 Plugin**：statusline built-in plugin（小-中），但作为首个示范性 plugin 需要高质量
- **文档**：built-in plugin 开发指南（中）
- **风险点**：pi extension setStatus 文本直接透传（不做解析），风险低；model 切换的 RPC 可用性需验证

**总工期估计**：5-7 天（1 人）
