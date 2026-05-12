# Slash 命令系统

## 设计稿

[views_chat.html](../../docs/designs/views_chat.html) — 包含 3 种状态的 UI 设计：State 1（匹配框弹出）、State 2（Skill 标签选中）、State 3（消息中 skill badge）。底部注释块包含完整交互规范。

## 目标

实现聊天输入框的 slash 命令系统，支持内置命令和 Skill 触发，通过 `/` 前缀弹出匹配框，选中后按类型执行不同逻辑。

## 命令分类

| 类型 | 例子 | 前端行为 | 发给 pi 的内容 |
|------|------|---------|---------------|
| local | `/clear`, `/help` | 前端直接执行，不发送任何消息 | 无 |
| protocol | `/compact` | 通过 ws 发送 `session.compact` 消息 | 无（独立协议通道） |
| skill | `/code-trace` | 选中后输入框上方显示 skill 标签 | `/skill:<name>[ <用户消息>]` |

## 交互流程

### 1. 触发与匹配

1. 用户在输入框输入 `/` → 向上弹出匹配框
2. 继续输入字符 → 子串过滤（不区分大小写）
3. 最多显示 5 项，超出可滚动
4. 每项前置类型标签：CMD（灰色 tag）或 SK（accent 色 tag）
5. 所有命令按 name 字母排序，不分组

### 2. 键盘操作

| 按键 | 行为 |
|------|------|
| `↑` / `↓` | 导航选中项 |
| `Tab` | 立即确认当前选中项 |
| `Enter` | 确认当前选中项 |
| `Escape` | 关闭匹配框 |

### 3. 选中后行为

**CMD 类型：** 立即执行对应操作，清空输入框。

| 命令 | 执行 |
|------|------|
| `/clear` | 清空当前 session 的聊天记录（chatStore） |
| `/compact` | 发送 ws 消息 `{ type: 'session.compact', payload: { sessionId } }` |
| `/help` | 在聊天流中插入一条系统消息，列出所有可用命令 |

**SK 类型：** 匹配框关闭，输入框上方出现 skill 标签。

### 4. Skill 标签

- 小圆角标签，显示 skill 名（如 `code-trace`）
- 右侧 `×` 可取消（恢复普通输入模式）
- 带 accent 色勾 icon
- 输入框边框变为 accent 色
- **单次模式**：发送消息后标签自动消失

### 5. Skill 消息发送

用户在 skill 标签存在时按 Enter：
- 有用户消息 → 发送 `/skill:<name> <用户消息>`
- 无用户消息 → 发送 `/skill:<name>`
- 通过 pi 的 `prompt` 命令传递，pi 内部识别 `/skill:` 前缀

### 6. 聊天记录展示

发送 skill 消息后，用户消息气泡中在正文前显示一个小 skill badge，标识使用了哪个 skill。

## 数据源

### 内置命令（硬编码，3 个）

| name | type | description |
|------|------|-------------|
| `clear` | local | 清空当前对话 |
| `compact` | protocol | 压缩上下文，减少 token 消耗 |
| `help` | local | 显示可用命令列表 |

### Skill 命令（动态）

从 `providerStore.skills` 中提取 `enabled` 的 skill，映射为 slash 命令：

```
skill.name → 命令名
skill.description → 命令描述
type = 'skill'
```

两者合并后按 name 字母排序。

## 涉及文件

| 文件 | 改动范围 |
|------|---------|
| `src-electron/renderer/src/composables/useSlashCommands.ts` | 重写：命令类型化注册（local/protocol/skill） |
| `src-electron/renderer/src/components/chat/SlashMenu.vue` | 重写：5 项限制 + CMD/SK tag + 接收统一命令列表 |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | 修改：skill 标签 UI + activeSkill 状态 + handleSlashSelect 分发 |
| `src-electron/renderer/src/components/panel/PaneSessionView.vue` | 修改：接收 activeSkill，拼接 `/skill:` 前缀 |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | 修改：用户消息中渲染 skill badge |
| `src-electron/shared/src/message.ts` | 修改：Message 接口新增可选 skillName 字段 |

## 代码规范注意

- Skill 标签和 badge UI 使用 Tailwind 类或 `@apply`，不手写 CSS 选择器
- 过滤逻辑统一为 `name.toLowerCase().includes(filter.toLowerCase())`

## 已有基础设施（编码 agent 必读）

### pi 协议约束

pi 通过 JSONL stdin/stdout RPC 通信，用户消息只有一个入口：`{ type: 'prompt', message: string }`。没有独立的 skill/command 通道。Skill 触发格式是 `/skill:<name>` 或 `/skill:<name> <args>`，作为 prompt 文本发送，pi 内部识别 `/skill:` 前缀后加载对应 SKILL.md。

### protocol.ts 中已存在的类型

```typescript
// ClientMessageType 已包含:
'session.compact' | 'session.clear' | 'session.restore' | 'session.rename'
// ServerMessageType 已包含:
'session.compacting' | 'session.restored' | 'session.renamed'
```

不需要新增任何协议类型。

### useSession.ts 中已有方法

```typescript
// src-electron/renderer/src/composables/useSession.ts
function compactSession() {
  send({ type: 'session.compact', payload: { sessionId: sid } })
}
function clearSession() {
  send({ type: 'session.clear', payload: { sessionId: sid } })
}
```

plan Task 4 中 `/compact` 和 `/clear` 的执行可以直接调用 `useSession` 的方法，或通过 ChatInput emit 事件让 PaneSessionView 调用。

### chatStore 中已有方法

```typescript
// src-electron/renderer/src/stores/chat.ts
function clearMessages(sessionId: string) { ... }
```

### Message 接口位置

`src-electron/shared/src/message.ts` 第 27 行 `export interface Message`。
Task 5 新增 `skillName?: string` 可选字段。

### SkillInfo 接口

`src-electron/shared/src/provider.ts` 定义了 `SkillInfo`，包含 `id`, `name`, `description`, `enabled`, `triggers` 等字段。从 `providerStore.skills` 获取。

### SlashMenu.vue 当前实现

当前使用 `<Teleport to="body">` + `position: fixed` + 手动坐标计算定位。plan Task 2 重写时保留 Teleport 模式（避免 overflow:hidden 截断），只需改为接收 props commands。

### SlashMenu.vue 已有的键盘导航

当前代码已实现 ↑↓ 导航、Enter 确认、Escape 关闭、外部点击关闭。Task 2 保留这些逻辑，新增 Tab 立即确认。

### 已知预存 TS 错误（非本次改动引入）

以下文件有预存的类型错误，编码时不要花时间修复：
- `src-electron/renderer/src/composables/useContext.ts` — contextUsagePercent 属性不存在
- `src-electron/renderer/src/stores/chat.ts` — Message 到 Record<string,unknown> 转换
- `src-electron/renderer/src/mock/mock-ws.ts` 234-235 行 — 参数数量不匹配
- `src-electron/renderer/src/composables/useChat.ts` 247 行 — 'system' 不属于 MessageRole

## 不在范围内

- triggers 自然语言匹配（预留字段，暂不实现）
- 新增 ws 协议类型（`session.compact` 和 `session.clear` 已在 protocol.ts 中定义）
- Skill 管理功能（已有 SkillPane）
