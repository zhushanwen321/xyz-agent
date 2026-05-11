# Slash 命令系统 - 实现计划

## Task 1: 重写 useSlashCommands.ts

**文件**: `src-electron/renderer/src/composables/useSlashCommands.ts`

**改动**:
1. 定义命令类型系统：

```typescript
export type SlashCommandSource = 'builtin' | 'skill'

export type SlashCommandAction =
  | { type: 'local'; handler: (ctx: CommandContext) => void }
  | { type: 'protocol'; messageType: string }
  | { type: 'skill'; skillId: string }

export interface SlashCommand {
  name: string
  description: string
  source: SlashCommandSource
  action: SlashCommandAction
}

export interface CommandContext {
  sessionId: string
  // help 命令延迟获取：执行时从 getAllCommands() 读取完整列表
  getAllCommands: () => SlashCommand[]
  // 本地操作回调，由调用方注入
  onLocalAction: (action: 'clear' | 'help', data?: unknown) => void
}
```

2. 注册 3 个内置命令：
   - `clear`: local, 调用 `ctx.onLocalAction('clear')`
   - `compact`: protocol, messageType = `session.compact`
   - `help`: local, 调用 `ctx.onLocalAction('help', ctx.getAllCommands())`

3. 提供 `mergeSkillCommands(skills: SkillInfo[])` 方法：将 enabled skills 映射为 SlashCommand，去重后与内置命令合并

4. 提供 `filterCommands(filter: string)` 方法：`name.toLowerCase().includes(filter.toLowerCase())`，结果按 name 字母排序

5. 保留单例模式（模块级状态），防重复注册

**依赖**: protocol.ts, provider.ts (SkillInfo)

## Task 2: 重写 SlashMenu.vue

**文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue`

**改动**:
1. Props 接收统一命令列表：

```typescript
interface Props {
  visible: boolean
  commands: SlashCommand[]
}
```

2. 移除对 `providerStore` 和 `useSlashCommands` 的直接依赖
3. 限制最多显示 5 项（CSS max-height = 5 × 行高，overflow-y: auto）
4. 每项渲染类型 tag：

```
source === 'builtin' → <span class="...--cmd">CMD</span>
source === 'skill'   → <span class="...--sk">SK</span>
```

5. 选中项 emit `select` 事件，传递完整 SlashCommand 对象
6. 保留键盘导航（↑↓ Tab Enter Escape）和外部点击关闭
7. 样式使用 Tailwind 类或 `@apply`

## Task 3: 改造 ChatInput.vue

**文件**: `src-electron/renderer/src/components/chat/ChatInput.vue`

**改动**:
1. 新增 props：

```typescript
interface Props {
  isStreaming: boolean
  sessionId: string  // 新增：用于 CommandContext
}
```

2. 新增 `activeSkill` ref（SlashCommand | null）
3. 新增 skill 标签 UI（输入框上方，Tailwind 类）：

```
<div v-if="activeSkill" class="skill-tag-bar">
  <div class="skill-tag">
    <svg .../> {{ activeSkill.name }}
    <span @click="clearSkill">×</span>
  </div>
</div>
```

4. 使用 `useSlashCommands` 获取合并后命令列表，传给 SlashMenu
5. 构建 CommandContext：

```typescript
const cmdCtx: CommandContext = {
  sessionId: props.sessionId,
  getAllCommands: () => allCommands.value,
  onLocalAction: (action, data) => emit('local-action', { action, data }),
}
```

6. `handleSlashSelect(cmd: SlashCommand)` 分发：

```
'local'    → cmd.action.handler(cmdCtx), 清空输入框
'protocol' → emit('send-command', { type: cmd.action.messageType, payload: { sessionId } }), 清空输入框
'skill'    → activeSkill = cmd, 清空输入框
```

7. 修改 `handleSend`：activeSkill 存在时拼接 `/skill:<name> ` 前缀，发送后 clearSkill()
8. 新增 emits: `send-command`, `local-action`

## Task 4: 改造 PaneSessionView.vue

**文件**: `src-electron/renderer/src/components/panel/PaneSessionView.vue`

**改动**:
1. 监听 ChatInput 新事件：
   - `@send-command`: 协议命令，调用 `send({ type, payload })` 发送 ws 消息
   - `@local-action`: 本地命令分发
     - `clear` → chatStore 清空当前 session 消息
     - `help` → chatStore 插入系统消息（列出可用命令）
2. 传递 `sessionId` prop 给 ChatInput
3. `handleSend` 不需要修改（ChatInput 已拼接好 `/skill:` 前缀）

## Task 5: Skill Badge（消息气泡中的 skill 标识）

**文件**:
- `src-electron/shared/src/message.ts` (或定义 Message 接口的位置)
- `src-electron/renderer/src/components/chat/MessageBubble.vue`

**改动**:
1. Message 接口新增可选字段：

```typescript
interface Message {
  // ...existing fields
  skillName?: string  // 发送时通过 skill 触发时设置
}
```

2. ChatInput handleSend 中：activeSkill 存在时，emit 的消息对象增加 `skillName: activeSkill.name`
3. PaneSessionView handleSend：将 skillName 传入 chatStore.addMessage
4. MessageBubble.vue：当 `msg.role === 'user' && msg.skillName` 时，在正文前渲染 skill badge（小圆角 tag，样式同 skill 标签但更小）
