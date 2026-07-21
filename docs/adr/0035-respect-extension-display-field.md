# ADR 0035：尊重 extension 的 display 字段，删除 HIDDEN_CUSTOM_TYPES 黑名单

- **状态**：Proposed
- **日期**：2026-07-21
- **关联**：替换短期补丁 `HIDDEN_CUSTOM_TYPES`（commit c05c22c8）

## 背景（Context）

pi 的 `CustomMessage` 协议（`pi-mono/packages/coding-agent/src/core/messages.ts:46-50`）有一个 **必填** `display: boolean` 字段，语义：
- `false` = 完全不在 TUI/GUI 渲染（但仍进 LLM context，对 AI 有用）
- `true` = 用区别于 user message 的样式渲染

extension 经 `sendMessage({customType, content, display, details})` 注入 custom message。pi-goal/pi-todo 的 context 提示（`<goal_context>`/`<todo_context>`，customType: goal-context/goal-context-exceeded/todo-context）声明 `display: false`——这些是给 AI 的状态提醒，对用户是噪声（状态已由 SideDrawer Tasks tab 展示）。

**xyz-agent 三条转换路径都丢了 display**：

| 路径 | 文件 | 现状 |
|------|------|------|
| 实时（event-adapter → effect） | event-adapter.ts:509 已透传到 payload | chat-message-effects customStart effect（:534-555）没读 |
| 持久化 RPC（get_messages） | message-converter.ts:137-160 | 类型断言 + msg 构造都没 display |
| 持久化文件（JSONL） | session-history.ts:44-58 | mapEntries 没透传 `e.display` |

→ extension 声明的 `display: false` 不生效，goal/todo context 污染对话流。

此前用 `HIDDEN_CUSTOM_TYPES`（shared/constants.ts）黑名单在 renderer 渲染层打补丁——补丁式短期方案，每加一个 extension 注入 context 消息就要改黑名单，且忽视了 extension 自己声明的 display 意图。

## 决策（Decision）

修根因：透传 display + 渲染层按 display 统一过滤。

1. **shared.Message 加 `display?: boolean`**（optional，因 Message 是聚合类型含非 custom 消息；仅 role:system + customType 的消息填充）
2. **三条转换路径透传 display**：
   - chat-message-effects customStart effect 读 `payload.display`
   - message-converter custom 分支读 `cm.display`
   - session-history mapEntries 带 `display: e.display`
3. **renderer `filterDisplayableMessages` 改读 `m.display === false`**（仅 false 隐藏，undefined/true 都显示）
4. **删除 HIDDEN_CUSTOM_TYPES**（constants.ts 定义 + index.ts 导出 + messageTurns.ts import）
5. **过滤只在渲染层**（filterDisplayableMessages），chat store 保留完整 messages——fork/compact/replay 需完整历史（规则 7.5 可重开恢复）。**不下沉**到 message-converter（丢消息会破坏规则 7.5）。

## 替代方案（Alternatives）

- **下沉到 message-converter 过滤**：拒绝。converter 丢消息会让 fork/compact/replay 拿不到完整历史，破坏规则 7.5「对话流状态必须可重开恢复」。
- **维持 HIDDEN_CUSTOM_TYPES 黑名单**：拒绝。补丁方案，每加 extension 都要改，且忽视 extension 声明的 display 意图（约定被破坏）。

## 后果（Consequences）

**正面**：
- 尊重 extension 声明的 display 字段，零硬编码 extension 名
- 未来任何 extension 声明 `display: false` 自动生效，无需改 xyz-agent
- goal/todo 特判从「renderer 黑名单」收敛为「协议字段透传」，关注点归位

**负面**：
- 需改 7 个文件 + 2 个测试文件，但改动机械、有测试锁住
- display 默认值语义需明确（`=== false` 才隐藏，非 `!display`），否则 undefined 会被误隐藏

## 零误伤验证（已确认）

| customType | display | 处理 |
|-----------|---------|------|
| goal-context / goal-context-exceeded / todo-context | false | 隐藏（原 HIDDEN_CUSTOM_TYPES 全集） |
| workflow-result / subagent-bg-notify | true | 显示（BgNotifyCard / GuiComponentRenderer） |
| compactionSummary / branchSummary | 无 customType（独立字段） | 不受影响（`undefined === false` = false，保留） |
