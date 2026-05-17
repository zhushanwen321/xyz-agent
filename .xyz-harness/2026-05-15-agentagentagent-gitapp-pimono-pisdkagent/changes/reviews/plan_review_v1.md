# Plan 评审 v1

## 评审记录
- 评审时间：2026-05-15
- 评审类型：Plan 独立评审
- 评审对象：plan.md（对照 spec.md）
- 评审轮次：第 1 轮

## Spec 覆盖矩阵

| Spec In Scope 项 | Plan Task | 覆盖状态 | 说明 |
|-----------------|-----------|---------|------|
| 1. 基础设施：pi subagent extension 可用 | T0 | ✅ | 明确的验证步骤 |
| 2. Agent 发现同步 | T1+T2 | ✅ | 通过 providerStore.agents 获取列表，合并到 SlashMenu |
| 3. 用户手动触发（SlashMenu + 触发机制） | T2+T3 | ✅ | SlashMenu 展示 + sidecar 处理 |
| 4. LLM 自动调用 | 无 task | ✅ | spec 明确"零额外开发"，不需要 task |
| 5. 聊天内渲染（SubagentRenderer） | T4 | ✅ | 新建渲染组件 + 注册 |
| 6. 事件适配 | 无 task | ✅ | event-adapter.ts 已通用处理，不需要改动 |

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **resolved issue** | T3 与 spec Never 规则冲突 | T3 代码块 | T3 使用英文自然语言指令（`Call the subagent tool with exactly these parameters...`）触发 subagent。spec 的 Never 规则明确写"禁止用自然语言 prompt 触发 subagent（不可靠）"。plan 自身在注释中也承认"虽然 spec 说不用自然语言，但 pi RPC 的 prompt 命令只接受字符串"，这说明 plan 在实现时选择了与 spec 矛盾的方案。 | 如果 pi RPC 的 `prompt` 只接受字符串且无法直接触发 tool call，plan 应在 spec 层面标记此为 [AMBIGUOUS] 或提议 spec 修订，而非在 plan 中悄悄违反 Never 规则。备选：实现 spec 提到的"备选方案"（用 XML 标记包裹 agent name 和 task），这比自然语言指令更结构化。或调研 pi RPC 是否支持直接传入 tool call 请求（`client.prompt()` → pi 内部是否有 `--tool-call` 类参数）。|
| 2 | **resolved issue** | T2 文件路径 | T2 文件变更表 | `SlashCommandSource` 和 `SlashCommandAction` 类型定义在 `src-electron/renderer/src/composables/useSlashCommands.ts` 中（当前 L6-11），但 T1 的文件变更表将类型扩展也放在这个文件下。而 T1 的文件变更表同时列了 `protocol.ts` 和 `useSlashCommands.ts`，T2 又改了 `useSlashCommands.ts`。两个 task 交叉改动同一文件，没有说明 T2 的改动在 T1 之后的 diff 基础上叠加。 | 在 T2 中明确说明"基于 T1 已完成的类型扩展"，或把 `useSlashCommands.ts` 的类型扩展和 `mergeSkillCommands` 逻辑改动合并到同一个 task，避免同一文件被两个 task 交叉修改导致合并冲突。 |
| 3 | **resolved issue** | T2 签名变更影响分析 | T2 "具体改动" | plan 改了 `mergeSkillCommands(skills: SkillInfo[])` → `mergeSkillCommands(skills: SkillInfo[], agents: AgentInfo[])` 的签名，但 plan 自己在风险中也提到了"需检查所有调用方"。实际代码中 `ChatInput.vue` L127 是唯一调用方：`mergeSkillCommands(providerStore.skills)`。plan 没有在 T2 的文件变更表中列出 ChatInput.vue 需要更新这个调用（传入 `providerStore.agents`），而是把 ChatInput.vue 的改动仅归为"处理 agent action"。 | T2 的文件变更表 ChatInput.vue 行应补充说明：除了处理 agent action 回调，还需将 `mergeSkillCommands(providerStore.skills)` 改为 `mergeSkillCommands(providerStore.skills, providerStore.agents)`。这是签名变更的必须适配，遗漏会导致编译失败。 |
| 4 | **resolved issue** | T3 数据流断裂 | T3 + T2 数据流 | 完整链路分析：ChatInput `handleSend()` → emit('send', payload) → ChatPanel emit → PaneSessionView `handleSend()` → `chatStore.addMessage()` + `sendMessage(content)` → `useChat.sendMessage()` → `send({ type: 'message.send', payload: { sessionId, content } })`。当前 `sendMessage` 只发 `content` 字符串，`handleSend` 的 payload 只有 `{ content, skillName? }`。T2 在 ChatInput 中设计了 `pendingAgentAction`，但 plan 没有说明如何将 `subagent` 字段从 ChatInput 传递到 sidecar 的 `message.send` handler。具体断裂点：(1) ChatInput emit('send', ...) 的类型签名是 `{ content: string; skillName?: string }`，没有 `subagent` 字段；(2) PaneSessionView 的 `handleSend` 和 `useChat.sendMessage` 都只处理 content 字符串，不处理附加字段。 | 补充完整数据流设计：(a) 修改 ChatInput emit 类型增加 `subagent?` 字段；(b) PaneSessionView `handleSend` 需要检测 subagent 字段并传递到 WS 消息；(c) `useChat.sendMessage` 或 WS send 层需要支持 subagent 附加字段。这些改动涉及 ChatInput.vue、PaneSessionView.vue、可能还有 useChat.ts 或 ws-client.ts。plan 当前只提到 sidecar/server.ts 需要改动，前端到 sidecar 的传递链路完全缺失。 |
| 5 | **resolved issue** | T4 渲染器 props 一致性 | T4 描述 | plan 说 SubagentRenderer 的 props 是 `toolCall: ToolCall`（与 DefaultToolRenderer 一致），并说 ToolCallCard 通过 `getToolRenderer(toolName)` 查找。验证 ToolCallCard.vue L80-82：`onMounted` 时调用 `getToolRenderer(props.toolCall.toolName)` 获取组件，赋值给 `rendererComp`，然后通过 `<component :is="rendererComp" :tool-call="toolCall" />` 传入。这确实可行。但 plan 没有提到一个关键细节：ToolCallCard 的 header 区域（tool name、filePathHint、elapsed）对所有工具通用，SubagentRenderer 无法覆盖 header 的内容。spec 要求 Header 显示"agent name + 状态 + 耗时"，但 ToolCallCard 的 header 固定显示 `toolCall.toolName`（会是 "subagent"），不会显示具体 agent 名称。 | 方案选择：(A) 接受 ToolCallCard header 固定显示 "subagent"，agent name 在 body 区域的 SubagentRenderer 中显示（这是最简单的方案，与 bash/edit 等工具渲染一致）；(B) 修改 ToolCallCard 支持 header 自定义（复杂度高，改动面大）。建议选 A，并在 plan 中明确说明 agent name 在 body 显示而非 header。同时更新 spec AC 中的描述以保持一致。 |
| 6 | **resolved issue** | T1 SlashCommandAction 类型 | T1 类型扩展 | plan 将 `SlashCommandAction` 新增 `{ type: 'agent'; agentId: string }`。但在 T2 的 mergeAgentCommands 代码中，action 设为 `{ type: 'agent' as const, agentId: a.id }`。问题：后续 T2/T3 的 handleSlashSelect 和 handleSend 需要 `agentId`，但发送 subagent 指令需要的是 agent 的 `name`（pi subagent tool 的参数是 `agent: string`，传 agent name）。`a.id` 和 `a.name` 在 `AgentInfo` 中是两个不同字段。plan 需要明确：是通过 `agentId` 查找 agent name，还是直接在 action 中存储 agent name。 | 方案选择：(A) action 中同时存 `agentId` 和 `agentName`；(B) 只存 `agentName`，因为 pi subagent tool 需要的是 name 而非 id。建议选 B（`{ type: 'agent'; agentName: string }`），减少不必要的查找步骤。 |
| 7 | **SHOULD FIX** | T3 指令格式安全性 | T3 代码块 | `subagent.task` 中如果包含引号 `"` 或换行符，会破坏构造的指令字符串。plan 的风险点提到了这个问题但未给出解决方案。 | 添加转义处理：`subagent.task.replace(/"/g, '\\"').replace(/\n/g, '\\n')`。或改用 JSON 包裹的格式（更安全）：`JSON.stringify({ agent: subagent.agent, task: subagent.task })` 包裹在 XML 标记中。 |
| 8 | **SHOULD FIX** | T4 toolCall.input 格式验证 | T4 风险点 | plan 说 `toolCall.input` 是 JSON，需要 `JSON.parse`。但 event-adapter.ts L125-126 显示 `input` 字段来源是 `event.args ?? event.input`。pi subagent extension 的 tool 参数是 `SubagentParams`（TypeBox schema），`args` 可能已经是解析后的对象而非 JSON 字符串。ToolCall 的 `input` 字段类型是 `unknown`（message.ts L9），可能是对象也可能是字符串。 | SubagentRenderer 应处理两种情况：字符串时 JSON.parse，对象时直接使用。plan 的 `parsedInput` 已经用 `JSON.parse` 处理了字符串，但还需要加 `typeof` 检查。参考 BashToolRenderer.vue 的做法（L36）：`typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input`。 |
| 9 | **SHOULD FIX** | T2 SlashMenu.vue 颜色区分 | T2 具体改动 | plan 说 agent 标签"用不同色值或加前缀"与 skill 区分，但没有给出具体方案。当前代码 L23-25 中，builtin 用 `bg-border text-muted`，非 builtin（即 skill）用 `bg-accent-light text-accent`。如果 agent 也用 `bg-accent-light text-accent`，视觉上无法区分 agent 和 skill。 | 给出明确的颜色方案。例如 agent 用 `bg-blue-50 text-blue-600` 或其他能区分的颜色 token。 |
| 10 | **SHOULD FIX** | T0 验收标准模糊 | T0 验收标准 | "pi 启动后 get_available_models 或 tool list 中包含 subagent"——如何验证？没有给出具体的验证命令或 API 调用方式。 | 提供具体验证命令，例如通过 pi 的 JSON mode 发送 prompt 然后检查 tool list，或检查 pi 的 extension 加载日志。 |
| 11 | **NOTE** | T1 protocol.ts 改动 | T1 文件变更 | plan 说 protocol.ts "无需改类型定义"，只加注释。但 `ClientMessage.payload` 类型是 `Record<string, unknown>`，subagent 字段确实能传。注释改动不影响编译，但 sidecar 的 handler 中 `msg.payload.subagent as { agent: string; task: string }` 需要类型断言。这个做法可行但不是类型安全的。 | 可考虑定义 `MessageSendPayload` 接口替代 `Record<string, unknown>` 中的 `message.send` payload，提供类型安全。但这属于优化，不阻塞实现。 |
| 12 | **NOTE** | 依赖关系 | 执行顺序 | T2 和 T3 标记为可并行，但数据流分析显示 T2 的前端改动（ChatInput emit 携带 subagent 字段）和 T3 的 sidecar 改动需要协商 protocol 格式。如果 T2 和 T3 的开发者对 subagent 字段格式理解不一致（字段名 `subagent` vs `agentTask` vs 其他），会出现对接问题。 | 在 T3 中明确约定前端发送的 payload 格式：`{ sessionId, content, subagent?: { agent: string; task: string } }`，作为 T2 和 T3 的共享契约。 |
| 13 | **NOTE** | 工作量评估 | 全局 | plan 估计总改动 < 500 行，T2 是 ~60 行，T3 是 ~30 行，T4 是 ~80 行。验证代码后发现数据链路有断裂（问题 #4），实际前端改动可能需要额外 30-50 行（PaneSessionView handleSend 修改、ChatInput emit 类型修改、可能需要修改 useChat.ts 的 send payload）。总体估计可能偏低至 550-600 行，但差距不大。 | 将 T2 或 T3 的行数估计上调 20-30 行，并在 T2/T3 中补充数据链路传递的改动。 |

## 具体验证结果

### T2 `mergeSkillCommands` 签名变更

当前签名：`mergeSkillCommands(skills: SkillInfo[]): SlashCommand[]`（useSlashCommands.ts L43）

调用方仅一处：`ChatInput.vue` L127 `mergeSkillCommands(providerStore.skills)`

签名变更为 `(skills, agents)` 后，ChatInput.vue L127 必须更新为 `mergeSkillCommands(providerStore.skills, providerStore.agents)`。plan 的 T2 文件变更表对 ChatInput.vue 的描述只有"处理 action.type === 'agent' 的 slash select 回调"，**遗漏了更新 mergeSkillCommands 调用参数**。

### T3 结构化 prompt 可靠性

pi RPC 的 `client.prompt()` 只接受字符串。pi subagent extension 注册的 tool name 是 `"subagent"`，参数是 `{ agent?: string, task?: string, tasks?: [...], chain?: [...], agentScope?: string }`。

当前方案构造的指令：
```
Call the subagent tool with exactly these parameters:
- agent: "name"
- task: "user task"
Do not modify the agent name or task. Execute immediately.
```

这本质上是自然语言指令，违反 spec Never 规则"禁止用自然语言 prompt 触发 subagent"。即使格式较强，LLM 仍可能改写（概率不高但非零）。

**更好的方案**：使用 spec 提到的备选方案——XML 标记：
```
<tool_call tool="subagent">
{"agent": "name", "task": "user task"}
</tool_call />
```
但这同样依赖 LLM 理解 XML 标记并执行 tool call。真正的可靠方案需要 pi RPC 支持直接触发 tool call（非 prompt 字符串），但这需要 pi 源码改动，被 spec 禁止。所以这是一个需要回 spec 修订或标记歧义的点。

### T4 ToolCallCard 自定义渲染器机制

ToolCallCard.vue L30：`<component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />`

L80-82：`const r = getToolRenderer(props.toolCall.toolName)` → `rendererComp.value = r`

这确实支持通过 `registerToolRenderer('subagent', SubagentRenderer)` 注册自定义渲染器。但渲染器只能控制 body 区域（L29-32），不能覆盖 header（L4-21）。Header 固定显示 `toolCall.toolName`（即 "subagent"）和 `filePathHint`（从 input 中提取 `path/file_path/command` 字段）。

对于 subagent tool，header 会显示 "subagent" + 空 filePathHint（因为 input 中没有 path/file_path/command 字段），然后是耗时。agent name 只能在 body 的 SubagentRenderer 中展示。

### SlashMenu.vue 当前标签逻辑

当前 L23-27：
```vue
<span :class="[
  '...',
  cmd.source === 'builtin'
    ? 'bg-border text-muted'
    : 'bg-accent-light text-accent',
]">{{ cmd.source === 'builtin' ? 'command' : 'skill' }}</span>
```

这是严格的二分法（builtin / 非builtin=skill）。改为三分时需要同时修改 `:class` 条件和文本内容。plan 的修改代码正确描述了文本部分的三分逻辑，但颜色方案未明确。

### ChatInput.vue 当前 skill action 处理

`handleSlashSelect`（L171-191）中，skill action 走 else 分支（L184-190），设置 `activeCommand.value = cmd` 并可选预填 argumentHint。

`handleSend`（L193-225）中，skill action 的处理（L210-214）：
```ts
case 'skill': {
  const prefix = `/skill:${cmd.name}`
  const content = trimmed ? `${prefix} ${trimmed}` : prefix
  emit('send', { content, skillName: cmd.name })
  break
}
```

这是将 skill 触发编码为 `/skill:name task` 格式的消息内容，通过 emit('send', ...) 发出。对于 agent action，plan 设计了 `pendingAgentAction`，但 handleSend 中没有对应的 case 'agent' 分支。需要在 handleSend 的 switch 中添加 `case 'agent'` 分支，构造携带 subagent 字段的 emit。同时 `handleSlashSelect` 中需要处理 agent 类型（类似 skill 的 else 分支）。

## 结论

**需修改后重审**

核心问题：
1. **T3 与 spec Never 规则直接冲突**（#1）——使用了 spec 明确禁止的自然语言触发方式
2. **前端到 sidecar 的 subagent 数据传递链路断裂**（#4）——plan 只描述了 sidecar 的接收处理，完全没涉及前端如何将 subagent 字段从 ChatInput 传递到 WS 消息
3. **mergeSkillCommands 签名变更的调用方适配遗漏**（#3）——会导致编译失败
4. **agentId vs agentName 混淆**（#6）——pi subagent tool 需要 agent name，但 action 中存的是 agent id

### Summary

Plan 评审完成，第 1 轮，6 条 resolved issue（其中 #1 spec 冲突和 #4 数据流断裂是最关键的阻塞项），4 条 SHOULD FIX，3 条 NOTE。需修改后重审。
