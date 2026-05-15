# Agent 通过 Subagent 机制在聊天中使用

## 目标

用户在 xyz-agent 中可以通过 pi 的 subagent extension 调用 agent，支持两种触发方式：
1. **LLM 自动调用**：用户在对话中提出需求，LLM 判断需要委派并自动调用 subagent tool
2. **用户手动触发**：用户通过 UI（slash command `/agent:name` 或 agent 选择器）指定 agent 和任务

Agent 在独立 pi 子进程中执行，context 完全隔离，结果返回主 session 的聊天流。

## 范围

### In Scope

1. **基础设施**：确保 pi 的 subagent extension 已安装且可用
2. **Agent 发现同步**：xyz-agent 管理的 agent 能被 pi subagent extension 发现
3. **用户手动触发**：
   - SlashMenu 中展示可用 agent（`/agent:name` 格式）
   - 用户选择 agent 后输入 task，构造消息触发 subagent tool
4. **LLM 自动调用**：pi 的 LLM 自行决定何时调用 subagent tool（零额外开发，依赖 subagent extension）
5. **聊天内渲染**：subagent tool 调用在聊天流中以结构化卡片展示（agent 名称、状态、输出）
6. **事件适配**：sidecar 的 EventAdapter 识别并转发 subagent tool 的结构化事件数据

### Out of Scope

- **Mode 1（prompt 注入）**：不做直接在当前 session 注入 agent system prompt
- **Background agent + collect**：异步执行、后台 agent 管理面板（二期）
- **Parallel/chain 模式 UI**：多 agent 并行/链式的高级触发 UI（二期）
- **pi 源码改动**：完全复用 pi 现有的 subagent extension
- **Agent 创建/编辑 UI 改动**：已有 AgentsPane.vue 维持不变
- **Agent 执行进程管理**：由 pi subagent extension 内部处理，sidecar 不直接 spawn pi 子进程

## 约束

### 技术约束

| 约束项 | 说明 |
|--------|------|
| Agent 执行机制 | 必须通过 pi 的 subagent extension，不在 sidecar 中重新实现进程管理 |
| Agent 发现格式 | pi subagent 读取 `~/.pi/agent/agents/` 下的 flat `.md` 文件（YAML frontmatter + body） |
| xyz-agent 扫描格式 | xyz-agent 的 agent-scanner 读取同目录下的子目录（`<name>/agent.md`） |
| 共存现状 | 两种格式已在 `~/.pi/agent/agents/` 中共存（每个 agent 同时有 `.md` 文件和子目录） |
| 前端框架 | Vue 3 + TypeScript + Tailwind CSS v3 + xyz-ui 组件库 |
| Sidecar 通信 | WebSocket，前端通过 ws-client.ts + event-bus.ts 消息分发 |
| 状态管理 | Pinia store（providerStore） |
| Session 隔离 | 所有消息必须带 sessionId，前端按 sessionId 路由 |

### 功能约束

| 约束项 | 说明 |
|--------|------|
| Agent 必须被 pi 发现 | 只有 pi subagent extension 能发现的 agent 才可被调用（即 `~/.pi/agent/agents/` 下有对应的 `.md` 文件） |
| 仅 enabled agent 可触发 | 用户手动触发时，SlashMenu 只展示 enabled 的 agent |
| 依赖活跃 pi session | subagent tool 在主 session 的 LLM loop 中执行，需要活跃 session |
| subagent extension 前提条件 | pi 启动时必须加载 subagent extension。**前提条件**：`~/.pi/extensions/subagent/` 需存在（指向 `~/GitApp/pi-mono/packages/coding-agent/examples/extensions/subagent/` 的 symlink）。如不存在，需在开发前手动创建。这是环境配置，不是本期代码交付物 |

## 已做决策

| 决策项 | 选择 | 理由 | 是否可推翻 |
|--------|------|------|------------|
| 执行模式 | 只做 Mode 2（subagent tool），不做 Mode 1（prompt 注入） | subagent 有 context 隔离，适合复杂 agent 场景；prompt 注入等同于角色扮演，价值低 | 否 |
| 执行引擎 | 复用 pi subagent extension，不自己 spawn pi | pi 的 extension 已成熟（single/parallel/chain/background），重新实现无意义 | 否 |
| 手动触发方式 | SlashMenu `/agent:name`，发送时用 protocol 层 message 而非自然语言 | 避免 LLM 忽略/改写指令的不可靠性（见下文手动触发机制） | 否 |
| Agent 发现同步 | 依赖 `~/.pi/agent/agents/` 下已有的 flat `.md` 文件 | pi subagent extension 和 xyz-agent 已共用同一目录，flat `.md` 文件已存在 | 否 |
| 前端渲染 | 复用 ToolCallCard + 注册 subagent 专属 renderer | 与 bash/read/edit 等工具的渲染模式一致，通过 `tool-renderer-registry.ts` 注册 `SubagentRenderer` | 否 |
| SlashMenu 视觉区分 | agent 条目的 source 标签显示 "agent" 文字，与 skill 的 "skill" 和 builtin 的 "command" 区分 | 复用现有 `cmd.source` 三分逻辑，新增 `SlashCommandSource = 'builtin' | 'skill' | 'agent'` | 否 |

## 行为约束

### Always（必须遵守）

- subagent tool 调用的结果必须包含 agent 名称、执行状态、输出内容
- 手动触发时通过 protocol 层 message 构造触发指令（见下文"手动触发机制"）
- SlashMenu 中 agent 条目的 source 标签必须显示 "agent" 文字（区别于 skill 的 "skill" 和 builtin 的 "command"）
- 所有消息必须带 sessionId

### Ask First（需要确认）

- LLM 自动调用 subagent 时是否需要用户确认（extension 已有 `confirmProjectAgents` 机制，通过 `extension_ui_request` → `message.tool_call_pending` 已有处理链路）

### 手动触发机制

用户选择 agent + 输入 task 后，发送消息时**不**构造自然语言 prompt（如"请使用 subagent..."），而是采用 protocol 层 message 的方式：

1. 前端发送 `message.send`，payload 中增加 `subagent` 字段：`{ content: "user task", subagent: { agent: "name", task: "user task" } }`
2. sidecar 收到后，识别 `subagent` 字段，向 pi RPC 发送 prompt 时附加明确的 tool call 指令
3. 具体 prompt 格式待 plan 阶段确定，但原则是：结构化数据，不让 LLM 有"理解并决定"的空间

> **备选方案**：如果 protocol 层改动复杂度过高，可退而使用强格式指令（如 XML 标记包裹 agent name 和 task），但仍优于纯自然语言。

### Never（绝对禁止）

- 禁止在 sidecar 中 spawn 独立 pi 进程执行 agent（让 pi subagent extension 做）
- 禁止修改 pi 源码
- 禁止注入 agent system prompt 到主 session（不做 Mode 1）
- 禁止硬编码 agent 列表（必须动态获取）
- 禁止用自然语言 prompt 触发 subagent（不可靠）

## 已有基础设施

### pi Subagent Extension（已存在，不需开发）

| 位置 | 能力 |
|------|------|
| `~/GitApp/pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts` | 注册 `subagent` tool，支持 single/parallel/chain 模式 |
| `~/GitApp/pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts` | Agent 发现：读取 `~/.pi/agent/agents/` 下的 flat `.md` 文件 |

**Subagent 执行流程**：
```
主 pi session LLM 调用 subagent tool { agent: "name", task: "..." }
  → discoverAgents() 从 ~/.pi/agent/agents/ 找到 agent 配置
  → spawn `pi --mode json -p --no-session --append-system-prompt <tempFile> --model <agent.model>`
  → 子进程独立执行，stdout 流式输出 JSON 事件
  → 汇总结果返回主 session（tool result）
```

**Agent 配置文件格式**（flat `.md`）：
```yaml
---
name: batch-code-tracer
description: Code-Trace 执行专家...
tools: read,edit,write,bash
model: llm-simple-router/glm-5.1
---

# Agent system prompt body...
```

### xyz-agent 已有代码

| 位置 | 方法/组件 | 用途 | 状态 |
|------|----------|------|------|
| `sidecar/src/agent-scanner.ts` | `scanAgents()` | 扫描 agent 目录（子目录格式） | ✅ 已实现 |
| `sidecar/src/server.ts` L232-252 | agent CRUD handler | scanAgents / setAgent / deleteAgent | ✅ 已实现 |
| `shared/src/provider.ts` | `AgentInfo`, `ScannedAgentInfo` | 类型定义 | ✅ 已实现 |
| `renderer/components/settings/AgentsPane.vue` | Agent 管理 UI | 扫描、导入、编辑 agent | ✅ 已实现 |
| `renderer/stores/provider.ts` | agent store | 管理导入的 agent 列表 | ✅ 已实现 |
| `sidecar/src/event-adapter.ts` | `translate()` | tool_execution_start/end 已通用处理 | ✅ 已实现 |
| `renderer/composables/useChat.ts` L103-124 | onToolCallStart/End | 聊天中 tool call 渲染 | ✅ 已实现 |
| `renderer/composables/useSlashCommands.ts` | SlashMenu 数据源 | skill + 内置命令 | ⚠️ 需扩展 |
| → `SlashCommandSource` 类型 | 当前 `'builtin' \| 'skill'` | 需新增 `'agent'` | 🔧 需改造 |
| → `mergeSkillCommands()` | 只处理 skill 映射 | 需新增 `mergeAgentCommands()` | 🔧 需改造 |
| `renderer/components/chat/SlashMenu.vue` L23-27 | source 标签渲染 | 当前二分：`cmd.source === 'builtin' ? 'command' : 'skill'` | 🔧 需改为三分 |
| `renderer/lib/tool-renderer-registry.ts` | 工具渲染注册表 | 注册 bash/read/edit/write 的专属 renderer | ✅ 已实现 |
| `renderer/lib/register-tool-renderers.ts` | 渲染器注册入口 | 需注册 `SubagentRenderer` | 🔧 需改造 |
| `renderer/components/chat/ToolCallCard.vue` | 通用 ToolCall 卡片 | 通过 `getToolRenderer(toolName)` 查找专属 renderer | ✅ 已实现 |
| `shared/src/protocol.ts` | WS 消息协议 | `ClientMessageType` 和 `ServerMessageType` 定义 | 🔧 需扩展（如手动触发走 protocol 层） |
| `renderer/components/chat/SlashMenu.vue` | SlashMenu UI | `/` 命令选择器 | ✅ 已实现 |
| `src-electron/.xyz-agent/agents.json` | 持久化存储 | 导入的 agent 列表 | ✅ 已实现 |

### Agent 文件系统现状

`~/.pi/agent/agents/` 目录下每个 agent 同时存在两种格式：
- `batch-code-tracer.md` — flat 文件（pi subagent extension 读取）
- `batch-code-tracer/` 目录 — 子目录（xyz-agent agent-scanner 读取）

两种格式数据来源相同，内容一致。xyz-agent 导入 agent 时已将 content 写入 agents.json，但**不会**自动创建/同步 flat `.md` 文件。

## 数据流

### LLM 自动调用 Subagent（零额外开发）

```
用户发送消息 → pi LLM 判断需要委派
  → LLM 调用 subagent tool { agent: "name", task: "..." }
  → pi subagent extension spawn 子进程执行
  → tool_execution_start/update/end 事件通过 RPC 流出
  → EventAdapter 已有通用处理 → 前端 useChat 已有通用处理
  → tool result 返回主 session → LLM 继续对话
```

### 用户手动触发 Agent

```
用户在聊天框输入 `/`
  → SlashMenu 展示 agent 列表（providerStore.agents.filter(a => a.enabled)）
  → 用户选择 `/agent:name`
  → 输入框预填 `/agent:name `，用户输入附加 task
  → 发送时前端构造 message.send，payload 包含 subagent 字段
  → sidecar 识别 subagent 字段，构造结构化指令发给 pi RPC
  → 后续流程同 LLM 自动调用
```

### Subagent 渲染方案

**复用现有 ToolCallCard + 注册 SubagentRenderer**：

1. `register-tool-renderers.ts` 中注册 `registerToolRenderer('subagent', SubagentRenderer)`
2. `SubagentRenderer.vue` 从 `toolCall.input`（JSON）中提取 `agent`、`task` 字段
3. Header 显示：tool name "subagent" + agent 名称 + 执行状态指示器
4. Body 展开：agent 输出文本（toolCall.output）
5. 状态：复用 ToolCallCard 的 running/completed/error 状态逻辑和动画

**SubagentRenderer 展示字段**：
| 区域 | 内容 | 数据来源 |
|------|------|----------|
| Header | agent 名称（从 input.agent 解析） | toolCall.input |
| Header | 执行状态指示器（spinner ✓ ✗） | toolCall.status |
| Header | 耗时 | toolCall.startTime/endTime |
| Body | agent task 描述 | toolCall.input.task |
| Body | agent 输出文本 | toolCall.output |
| Body | 错误信息（如有） | toolCall.error |

**不需要单独处理 tool_execution_update**：pi subagent extension 通过 `onUpdate` 回调流式更新，但 EventAdapter 当前未处理 `tool_execution_update` 事件（switch 中无此 case）。subagent 的中间进度在当前实现中不会推送到前端，只有最终的 `tool_execution_end` 携带完整结果。

## 验证方式

1. **基础设施验证**：确认 pi 启动时 subagent extension 已加载（检查 tool list）
2. **自动调用验证**：在聊天中提出需要委派的任务，观察 LLM 是否自动调用 subagent
3. **手动触发验证**：通过 SlashMenu 选择 agent + 输入 task，确认触发 subagent 执行
4. **渲染验证**：subagent 执行过程中聊天流正确显示 agent 名称、执行状态、输出内容
5. **边界验证**：agent 不存在时错误提示；agent disabled 时不在 SlashMenu 展示

## 验收标准

### 前提条件（环境配置，非本期代码交付物）
- [ ] `~/.pi/extensions/subagent/` 指向 pi 源码中的 subagent extension（symlink）
- [ ] pi 启动时 subagent extension 加载成功（可通过 pi tool list 验证）
- [ ] `~/.pi/agent/agents/` 下有 flat `.md` 文件可被 pi subagent 发现

### 功能验收
- [ ] `SlashCommandSource` 类型扩展为 `'builtin' | 'skill' | 'agent'`
- [ ] SlashMenu 中 agent 条目的 source 标签显示 "agent" 文字（非 "skill" 或 "command"）
- [ ] SlashMenu 仅展示 enabled agent（`providerStore.agents.filter(a => a.enabled)`）
- [ ] 选择 agent 后输入框预填 `/agent:name `
- [ ] 发送的消息通过 protocol 层可靠触发 subagent tool 调用
- [ ] `register-tool-renderers.ts` 注册了 `SubagentRenderer`
- [ ] SubagentRenderer 从 `toolCall.input` 提取 agent 名称，Header 显示 agent name + 状态 + 耗时
- [ ] SubagentRenderer Body 展开显示 agent task 描述和输出文本
- [ ] agent 执行错误时 SubagentRenderer 展示错误信息（红色边框 + error text）
- [ ] LLM 自动调用 subagent 时同样使用 SubagentRenderer 渲染
- [ ] 无 enabled agent 时 SlashMenu 不展示 agent 分类，不报错
