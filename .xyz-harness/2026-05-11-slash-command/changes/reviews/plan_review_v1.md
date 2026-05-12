## 评审记录 v1
- 评审时间: 2026-05-11
- 评审类型: 计划评审
- 评审对象: spec.md + plan.md

### 代码影响分析

| 文件 | 当前状态 | 改动规模 |
|------|---------|---------|
| `useSlashCommands.ts` | 83 行，基础实现（3 个 stub 命令，无类型区分，无 skill 合并） | 重写 |
| `SlashMenu.vue` | 185 行，内部合并 skills，无 CMD/SK tag，无 5 项限制，Tab 未处理 | 重写 |
| `ChatInput.vue` | 173 行，简单 `/` 触发 + emit send，无 activeSkill，无 skill 标签 | 中度修改 |
| `PaneSessionView.vue` | 133 行，handleSend + ws 事件处理，无 send-command 事件 | 小幅修改 |

**已确认存在的关联文件**：
- `MessageBubble.vue` — 当前渲染 user/assistant/system 消息，无 skill badge 逻辑
- `useSession.ts` — 已有 `compactSession()` / `clearSession()` 实现
- `shared/provider.ts` — `SkillInfo` 接口含 `id`, `name`, `description`, `enabled` 等字段
- `shared/message.ts` — `Message` 接口无 `skillName` 字段

### 发现的问题

| # | 优先级 | 文件 | 描述 | 建议 |
|---|--------|------|------|------|
| 1 | MUST FIX | plan.md 全局 | **Spec 第 6 节（聊天记录展示）未被 plan 覆盖**：spec 要求"发送 skill 消息后，用户消息气泡中在正文前显示一个小 skill badge，标识使用了哪个 skill"。plan 的 4 个 task 均未涉及此需求。MessageBubble.vue 不在 spec"涉及文件"表中，但 spec 第 6 节明确要求修改消息展示。同时 Message 接口（shared/message.ts）当前无 `skillName` 字段，要实现 badge 需要：(1) Message 接口加可选的 `skillName` 字段，(2) ChatInput/PaneSessionView 发送时在消息中携带 skill 信息，(3) MessageBubble.vue 渲染 badge。 | plan 需新增 Task 5 专门处理 skill badge：修改 Message 接口 → ChatInput 发送时注入 skillName → MessageBubble 渲染 badge。或将 spec 第 6 节标记为"第二期实现"，在 plan 中明确标注。 |
| 2 | MUST FIX | plan.md Task 1 + Task 3 | **`/help` 命令的执行路径不明确**：spec 要求 help"在聊天流中插入一条系统消息，列出所有可用命令"。plan Task 1 定义了 `CommandContext`（含 chatStore），Task 3 说 local 命令调用 `cmd.action.handler(ctx)`。但 ChatInput 当前没有 `chatStore` 和 `sessionId` 的访问途径，plan 没有说明这些依赖如何注入。同时，help 需要列出"所有可用命令"（含 skills），但 help handler 注册时 skills 可能尚未合并，无法获取完整列表。 | (1) 在 plan 中明确 ChatInput 获取 CommandContext 的方式（新增 props 或 inject store），(2) help handler 改为延迟获取命令列表（在执行时从 useSlashCommands 读取当前已注册的完整列表），而非注册时固定。 |
| 3 | LOW | plan.md Task 1 | **大小写过滤逻辑未明确**：spec 要求"子串过滤（不区分大小写）"，plan 仅说"子串匹配"。当前代码有 bug：`cmd.name.includes(filter.value.toLowerCase())` 只对 filter 做了 toLowerCase 而未对 cmd.name 做，导致大写命令名无法匹配小写 filter。 | plan 中补充说明过滤逻辑为 `cmd.name.toLowerCase().includes(filter.toLowerCase())` |
| 4 | LOW | plan.md Task 3 | **Skill 标签 UI 的 CSS 规范合规性**：plan 中给出的 skill tag HTML 使用了手写 CSS 类名（`skill-tag-bar`、`skill-tag`），按 CLAUDE.md 规范 `<style scoped>` 内只允许 `@apply`。实现时需用 Tailwind 类或 `@apply` 指令。 | 在 plan 中注明 skill tag UI 使用 Tailwind 类实现，或在 `<style scoped>` 中用 `@apply` 组合。 |
| 5 | LOW | plan.md Task 3 | **`/compact` 命令执行路径绕行**：spec 将 compact 归类为 protocol 类型，plan 让 ChatInput emit `send-command` 事件 → PaneSessionView 接收并调用 ws send。但 useSession.ts 已有现成的 `compactSession()` 和 `clearSession()` 方法。protocol 命令通过 ChatInput → PaneSessionView 中转增加了不必要的耦合。 | 考虑 local 和 protocol 命令统一通过 CommandContext 执行（CommandContext 中注入 ws send 函数），减少 ChatInput → PaneSessionView 的事件链路。或者明确说明选择当前方案的理由（如 ChatInput 不应依赖 ws-client）。 |
| 6 | LOW | spec.md | **spec"涉及文件"表不完整**：spec 第 6 节要求修改消息气泡展示，但涉及文件表只列了 4 个文件，未包含 MessageBubble.vue。第 6 节的需求与涉及文件表存在矛盾。 | spec 中补充 MessageBubble.vue 到涉及文件表，或将第 6 节移出本次范围并在"不在范围内"中说明。 |

### 结论

需修改后重审。2 条 MUST FIX：

1. **#1**: Plan 缺少 spec 第 6 节（skill badge in message bubble）的实现 task，这是一个完整的功能需求被遗漏。
2. **#2**: `/help` 命令的执行路径存在设计缺口 — ChatInput 缺少 CommandContext 依赖注入方式，且 help 需要动态获取完整命令列表（含 skills），但 plan 未说明如何解决时序问题。

建议修复方向：
- 新增 Task 5 覆盖 skill badge 需求（Message 接口扩展 + MessageBubble 渲染），或明确将 spec 第 6 节标记为第二期
- 明确 ChatInput 获取 chatStore/sessionId 的方式（建议通过 props 传入，保持组件纯粹性）
- 补充 help 命令的延迟获取设计
