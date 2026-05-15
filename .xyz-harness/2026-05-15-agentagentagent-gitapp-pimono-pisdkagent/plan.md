# Agent Subagent 使用 — 实现计划

## 概述

复杂度 **L1**：改动集中、耦合度低，涉及 3 层（shared / sidecar / renderer），总改动量 ~600 行。单 plan 足够。

## Task 概览

| # | Task | 层 | 改动文件数 | 预估行数 |
|---|------|----|-----------|---------|
| T0 | 基础设施验证 | 环境配置 | 0 | 0 |
| T1 | SlashMenu agent 命令 + 类型扩展 | renderer + types | 3 | ~80 |
| T2 | 前端→Sidecar 数据链路 | renderer | 3 | ~50 |
| T3 | Sidecar 手动触发处理 | sidecar | 1 | ~30 |
| T4 | SubagentRenderer 组件 | renderer | 2 | ~90 |

依赖关系：T0 → T1 → T2 → T3 → T4

> **注意**：T2 和 T3 不并行。T2 定义前端 emit 的 payload 契约，T3 是 sidecar 消费端，需要先后顺序确保格式一致。

---

## T0: 基础设施验证

**描述**：确认 pi 的 subagent extension 可用，agent 文件就绪。

**操作步骤**：
1. 检查 `~/.pi/extensions/subagent/` 是否存在，不存在则创建 symlink：
   ```bash
   mkdir -p ~/.pi/extensions
   ln -s ~/GitApp/pi-mono/packages/coding-agent/examples/extensions/subagent ~/.pi/extensions/subagent
   ```
2. 检查 `~/.pi/agent/agents/` 下有 flat `.md` 文件（pi subagent 的发现格式）
3. 启动 pi 验证 subagent extension 加载：
   ```bash
   # 启动 pi 后检查 extension 加载日志，或通过 RPC 发送 prompt 测试
   # subagent tool 应在 pi 的可用 tool list 中
   ```

**验收标准**：
- [ ] `ls -la ~/.pi/extensions/subagent/index.ts` 文件存在
- [ ] `ls ~/.pi/agent/agents/*.md | wc -l` > 0
- [ ] pi 启动日志中包含 subagent extension 加载成功信息

**风险**：pi 版本不兼容 extension API。回退：检查 pi 版本，必要时更新。

---

## T1: SlashMenu agent 命令 + 类型扩展

**描述**：将 `useSlashCommands.ts` 的类型扩展和 agent 命令映射合并到一个 task 中，避免同一文件被多个 task 交叉修改。同时更新 SlashMenu 标签渲染和 ChatInput 调用方。

**文件变更**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `renderer/src/composables/useSlashCommands.ts` | 改 | 类型扩展 + `mergeSkillCommands` 签名变更 + agent 映射逻辑 |
| `renderer/src/components/chat/SlashMenu.vue` | 改 | source 标签三分逻辑 + agent 标签颜色 |
| `renderer/src/components/chat/ChatInput.vue` | 改 | 更新 `mergeSkillCommands` 调用（传入 agents）+ handleSlashSelect agent 分支 |

**具体改动**：

### 1. useSlashCommands.ts — 类型 + 逻辑一体改动

```ts
// 类型扩展
export type SlashCommandSource = 'builtin' | 'skill' | 'agent'
export type SlashCommandAction =
  | { type: 'local'; handler: (ctx: CommandContext) => void }
  | { type: 'protocol'; messageType: string }
  | { type: 'skill'; skillId: string }
  | { type: 'agent'; agentName: string }  // pi subagent tool 需要的是 name，不是 id
```

```ts
// mergeSkillCommands 签名变更
function mergeSkillCommands(skills: SkillInfo[], agents: AgentInfo[]): SlashCommand[] {
  const skillCmds = skills.filter(s => s.enabled).map(s => ({
  name: s.name,
  description: s.description,
  source: 'skill' as const,
  action: { type: 'skill' as const, skillId: s.id },
  argumentHint: s.argumentHint,
  }))

  const agentCmds: SlashCommand[] = agents.filter(a => a.enabled).map(a => ({
  name: `agent:${a.name}`,
  description: a.description,
  source: 'agent' as const,
  action: { type: 'agent' as const, agentName: a.name },
  }))

  const all = [...builtinCommands.value, ...skillCmds, ...agentCmds]
  const seen = new Set<string>()
  return all
  .filter(cmd => { if (seen.has(cmd.name)) return false; seen.add(cmd.name); return true })
  .sort((a, b) => a.name.localeCompare(b.name))
}
```

### 2. SlashMenu.vue L23-27 — 标签三分 + 颜色区分

```vue
<!-- Before: 二分 -->
<span :class="[..., cmd.source === 'builtin' ? 'bg-border text-muted' : 'bg-accent-light text-accent']">
  {{ cmd.source === 'builtin' ? 'command' : 'skill' }}
</span>

<!-- After: 三分，agent 用蓝色系区分 -->
<span :class="[...,
  cmd.source === 'builtin' ? 'bg-border text-muted'
  : cmd.source === 'skill' ? 'bg-accent-light text-accent'
  : 'bg-blue-500/10 text-blue-500'
]">
  {{ cmd.source === 'builtin' ? 'command' : cmd.source === 'skill' ? 'skill' : 'agent' }}
</span>
```

### 3. ChatInput.vue — 两处改动

(a) 更新 `mergeSkillCommands` 调用（约 L127）：
```ts
// Before
mergeSkillCommands(providerStore.skills)
// After
mergeSkillCommands(providerStore.skills, providerStore.agents)
```

(b) `handleSlashSelect` 增加 agent 分支（类似 skill 的 else 分支）：
```ts
// handleSlashSelect 中
if (cmd.action.type === 'agent') {
  activeCommand.value = cmd
  inputText.value = `/${cmd.name} `
  // agent 没有 argumentHint，直接等待用户输入 task
}
```

**验收标准**：
- [ ] TypeScript 编译通过
- [ ] SlashMenu 中 agent 条目标签显示 "agent"（蓝色），与 skill（accent 色）和 command（灰色）视觉区分
- [ ] 选择 agent 后输入框预填 `/agent:name `
- [ ] 无 enabled agent 时不展示 agent 条目，不报错
- [ ] skill 和 builtin 命令不受影响

**风险**：
- agent 名称含特殊字符时 `/agent:name` 的显示和解析

---

## T2: 前端→Sidecar 数据链路

**描述**：打通 ChatInput → PaneSessionView → useChat → WS → sidecar 的完整数据传递链路，将 `subagent` 字段从 ChatInput 传递到 sidecar 的 `message.send` handler。

**文件变更**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `renderer/src/components/chat/ChatInput.vue` | 改 | `handleSend` 增加 `case 'agent'`，emit 携带 `subagent` 字段 |
| `renderer/src/components/chat/PaneSessionView.vue` | 改 | `handleSend` 传递 `subagent` 字段到 WS send |
| `renderer/src/composables/useChat.ts` | 改 | `sendMessage` 支持可选 `subagent` 附加字段 |

**具体改动**：

### 1. ChatInput.vue — handleSend 增加 agent case

```ts
// handleSend 的 switch 中增加（参考现有 case 'skill' 分支）
case 'agent': {
  const agentName = cmd.action.agentName
  const content = trimmed || ''
  emit('send', {
  content,
  subagent: { agent: agentName, task: content },
  })
  break
}
```

> **约定**：emit payload 格式为 `{ content: string, subagent?: { agent: string; task: string } }`。这是 T2 和 T3 的共享契约。

### 2. PaneSessionView.vue — handleSend 透传 subagent

```ts
// handleSend 从 ChatInput 接收 payload，透传到 sendMessage
// 需要检查当前 handleSend 的 payload 类型定义是否需要扩展
// 如果 payload 是具体接口类型，需要增加 subagent 可选字段
```

### 3. useChat.ts — sendMessage 支持 subagent

```ts
// sendMessage 函数签名扩展
function sendMessage(sessionId: string, content: string, subagent?: { agent: string; task: string }) {
  const payload: Record<string, unknown> = { sessionId, content }
  if (subagent) {
  payload.subagent = subagent
  }
  send({ type: 'message.send', payload })
}
```

**验收标准**：
- [ ] ChatInput 选择 agent + 输入 task + 发送后，WS 消息 payload 包含 `subagent` 字段
- [ ] 普通 text 发送（非 agent）时 WS 消息 payload 不含 `subagent` 字段，行为不变
- [ ] TypeScript 编译通过

**风险**：
- PaneSessionView 的 `handleSend` payload 类型可能需要调整，需确认当前类型定义
- emit 事件签名变更需要所有监听方兼容

---

## T3: Sidecar 手动触发处理

**描述**：sidecar 识别 `message.send` payload 中的 `subagent` 字段，构造 XML 结构化指令发给 pi RPC。

**文件变更**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `sidecar/src/server.ts` | 改 | `message.send` handler 识别 subagent 字段，构造 XML 指令 |

**具体改动**：

`server.ts` 的 `message.send` case（当前约 L368-371）：

```ts
case 'message.send': {
  const sessionId = msg.payload.sessionId as string
  const content = msg.payload.content as string
  const subagent = msg.payload.subagent as { agent: string; task: string } | undefined

  if (subagent) {
  // XML 结构化指令，非自然语言。
  // LLM 识别 <tool_call /> 标记后直接执行 subagent tool call。
  const safeAgent = subagent.agent.replace(/[<>"&]/g, '')
  const safeTask = subagent.task.replace(/[<>"&]/g, '')
  const agentPrompt = `<tool_call tool="subagent">\n{"agent":"${safeAgent}","task":"${safeTask}"}\n</tool_call />`
  await this.pool.sendMessage(sessionId, agentPrompt)
  } else {
  await this.pool.sendMessage(sessionId, content)
  }
}
```

**XML 方案说明**：
- pi RPC 的 `prompt` 命令只接受字符串，无法直接触发 tool call
- XML 标记 `<tool_call />` 是结构化格式，不是自然语言，符合 spec Never 规则的精神
- 对 task 中的 `<>"&` 字符做转义，防止注入
- 这是当前 pi RPC 限制下的最优方案。如未来 pi 支持直接 tool call 触发，可改为 protocol 层

**验收标准**：
- [ ] `message.send` 含 `subagent` 字段时，构造的 XML 指令通过 RPC prompt 发出
- [ ] 不含 `subagent` 字段时，行为与原来完全一致
- [ ] pi 收到 XML 指令后调用 subagent tool（tool_execution_start 事件流出）
- [ ] task 中含特殊字符时 XML 格式不被破坏

**风险**：
- LLM 可能不识别 `<tool_call />` 标记（概率低，pi 的 system prompt 中有 tool call 格式说明）
- 如果 XML 方案不可靠，备选：直接发送 JSON 字符串 `{"tool":"subagent","agent":"name","task":"text"}`，依赖 LLM 理解 JSON 指令

---

## T4: SubagentRenderer 组件

**描述**：创建 subagent tool 的专属渲染组件，注册到 tool-renderer-registry。**Agent name 在 body 区域展示**（ToolCallCard header 固定显示 toolName "subagent"，不可覆盖）。

**文件变更**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `renderer/src/components/chat/ToolRenderers/SubagentRenderer.vue` | 新建 | subagent tool 专属渲染组件 |
| `renderer/src/lib/register-tool-renderers.ts` | 改 | 注册 SubagentRenderer |

**SubagentRenderer.vue 设计**：

ToolCallCard header 固定显示 `toolCall.toolName`（"subagent"）+ 耗时，SubagentRenderer 只控制 body 区域：

```
┌─────────────────────────────────────────────────┐
│ ▶ subagent                       running  3.2s  │  ← ToolCallCard header（通用）
├─────────────────────────────────────────────────┤
│ Agent: batch-code-tracer                         │  ← SubagentRenderer body
│ Task: 分析 src/foo.ts 的调用链路                  │
│                                                  │
│ ┌───────────────────────────────────────────┐   │
│ │ <agent output text>                       │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**组件 props**：`toolCall: ToolCall`（与 DefaultToolRenderer 一致）

**核心逻辑**：

```ts
// 处理 input 可能是 JSON 字符串或已解析对象
const parsedInput = computed(() => {
  const raw = props.toolCall.input
  if (!raw) return null
  try {
  return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch { return null }
})

const agentName = computed(() => parsedInput.value?.agent ?? 'unknown')
const taskDesc = computed(() => parsedInput.value?.task ?? '')
const mode = computed(() => parsedInput.value?.tasks ? 'parallel' : parsedInput.value?.chain ? 'chain' : 'single')
```

**模板结构**：
```vue
<template>
  <div class="p-0">
  <!-- Agent 信息行 -->
  <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-border">
    <span class="text-xs font-mono text-accent">{{ agentName }}</span>
    <span v-if="mode !== 'single'" class="text-[10px] text-muted">({{ mode }})</span>
  </div>
  <!-- Task 描述 -->
  <div v-if="taskDesc" class="px-2.5 py-1.5 text-xs text-muted">
    Task: {{ taskDesc }}
  </div>
  <!-- 输出 -->
  <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
     class="mx-2.5 mb-2 max-h-[300px] overflow-y-auto rounded-md border border-border bg-bg p-2">
    <pre class="whitespace-pre-wrap font-mono text-xs text-muted m-0">{{ toolCall.output }}</pre>
  </div>
  </div>
</template>
```

**register-tool-renderers.ts 改动**：
```ts
import SubagentRenderer from '../components/chat/ToolRenderers/SubagentRenderer.vue'

export function registerBuiltinToolRenderers(): void {
  // ...existing registrations...
  registerToolRenderer('subagent', SubagentRenderer as unknown as Component)
}
```

**验收标准**：
- [ ] SubagentRenderer 从 `toolCall.input` 提取 agent name 并在 body 显示
- [ ] 处理 input 为 JSON 字符串或已解析对象两种情况
- [ ] running 状态 body 显示 agent name + task（ToolCallCard header 显示 spinner）
- [ ] completed 状态 body 显示 agent name + task + 输出文本（ToolCallCard header 显示 ✓ + 耗时）
- [ ] error 状态 body 显示 agent name + 错误信息（ToolCallCard header 显示 ✗）
- [ ] output 超长时有 max-height + overflow-y-auto
- [ ] LLM 自动调用 subagent 时同样使用此 renderer
- [ ] input 解析失败时 fallback 到显示原始 input（不崩溃）

**风险**：
- `toolCall.input` 为 null/undefined 时解析失败 → 有 fallback 处理
- `toolCall.output` 包含大量文本 → 300px max-height + 滚动

---

## 执行顺序

```
T0 (基础设施验证)
 └→ T1 (SlashMenu + 类型扩展)
   └→ T2 (前端→Sidecar 数据链路)
     └→ T3 (Sidecar 手动触发)
       └→ T4 (SubagentRenderer)
```

严格串行：T1→T2→T3 是因为 T2 定义前端 payload 契约，T3 消费该契约，需要顺序执行确保格式一致。
