# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-15 20:30
- 评审类型：Spec 独立评审
- 评审对象：`.xyz-harness/2026-05-15-agentagentagent-gitapp-pimono-pisdkagent/spec.md`
- 评审轮次：第 1 轮

### 六要素覆盖矩阵

| 要素 | 覆盖状态 | 说明 |
|------|---------|------|
| Outcomes | ⚠️ | 目标段落描述了两种触发方式和终态，但缺少可量化的成功指标（如"3 个 agent 可被发现并执行"），验收标准部分弥补了这一点 |
| Scope boundaries | ✅ | In Scope 6 条 + Out of Scope 6 条，边界清晰 |
| Constraints | ✅ | 技术约束表（7 项）+ 功能约束表（4 项），覆盖充分 |
| Decisions made | ✅ | 5 项决策，每项有选择/理由/是否可推翻 |
| Verification | ⚠️ | 验收标准 9 条存在，但部分不可量化（见问题 #1、#2） |
| 已有基础设施 | ✅ | pi subagent extension 能力描述 + xyz-agent 已有代码表（11 项）+ agent 文件系统现状 |

### 自包含性问题

1. **SlashMenu agent 渲染的视觉区分方式未明确**。行为约束写"必须与 skill 命令、内置命令视觉区分"，但没有给出区分方案（不同颜色？不同标签文字？分组？）。Phase 2 agent 需要自行猜测。

2. **手动触发时构造的消息格式未明确**。数据流写"发送时构造消息：'请使用 subagent 调用 agent 'name'，任务：user task'"，但这条自然语言指令是否足以可靠触发 subagent tool？如果 LLM 忽略或改写这条指令怎么办？行为约束写"可靠地触发 subagent tool（不让 LLM 忽略或修改指令）"，但没有给出具体机制。

3. **providerStore.agents 的过滤条件不完整**。数据流写"从 providerStore.agents 中 enabled 的列表"，但 providerStore.agents 包含所有导入的 agent（包括 disabled 的）。过滤逻辑是 `agents.filter(a => a.enabled)`，这个在 plan 中需要明确，但 spec 没有给出足够细节——不过 agent.enabled 字段已在 AgentInfo 中定义，可以推断。

4. **`useSlashCommands.ts` 的 `SlashCommandSource` 类型当前只有 `'builtin' | 'skill'`，不包含 `'agent'`**。spec 要求 SlashMenu 展示 agent 命令并与 skill 命令视觉区分，但 `SlashCommandSource` 类型需要扩展。spec 的"已有代码"表列出了该文件但未指出这个类型限制。

5. **SlashMenu.vue 中 source 标签的硬编码逻辑**。当前代码通过 `cmd.source === 'builtin' ? 'command' : 'skill'` 二分渲染标签文字和样式。新增 `'agent'` source 后需要三分逻辑，但 spec 没有提及这个改造点。

6. **"subagent tool 调用在聊天流中以结构化卡片展示"**——"结构化卡片"的 UI spec 缺失。需要渲染哪些字段？agent 名称、状态、输出、token 用量的布局和样式是什么？这是核心 UI 交付物但没有任何设计稿或 demo 参考。

### 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | resolved issue | 验收标准 | §验收标准 | AC-3 "与 skill/内置命令视觉区分" 不可量化、不可自动化测试。"视觉区分"需要明确定义：是标签文字不同（如显示"agent"而非"skill"）？还是颜色不同？还是分组显示？ | 改为具体标准，如"SlashMenu 中 agent 条目的 source 标签显示为 'agent'（区别于 skill 的 'skill' 和 builtin 的 'command'），背景色使用不同 CSS 变量" |
| 2 | resolved issue | 验收标准 | §验收标准 | AC-6 "展示为结构化卡片（agent 名称、状态、输出）" 没有 UI 规格。Phase 2 agent 不知道卡片长什么样、包含哪些元素、布局如何。 | 补充卡片的 UI 规格（字段列表、布局、交互行为）或引用 design demo。至少说明：复用现有 ToolCall 渲染组件还是新建 SubagentCard 组件 |
| 3 | resolved issue | 自包含性 | §数据流 > 用户手动触发 | 手动触发的"可靠触发机制"未明确。写了一条自然语言 prompt"请使用 subagent 调用 agent 'name'，任务：user task"，但行为约束要求"不让 LLM 忽略或修改指令"。这两者矛盾——自然语言指令本身不可靠。 | 明确触发方式：是修改发送消息的 protocol（如增加 payload 字段 `{ agentName, task }` 让 sidecar 构造 system instruction）？还是在 user message 前插入强格式指令？给出确定方案 |
| 4 | resolved issue | 自包含性 | §已有基础设施 | `useSlashCommands.ts` 的 `SlashCommandSource` 类型当前为 `'builtin' \| 'skill'`，不包含 `'agent'`。`mergeSkillCommands` 方法只处理 skill 映射。spec 列出了这些文件但没有指出类型扩展需求。 | 在已有代码表中注明"需扩展 SlashCommandSource 和 mergeSkillCommands"，或在数据流/行为约束中明确 |
| 5 | resolved issue | 六要素 | §约束 | "subagent extension 必须加载"是功能约束，但 spec 没有说明如何确保这一点。pi 启动时 extension 的加载机制是什么？是自动的还是需要配置？如果不自动加载，Phase 2 是否需要开发 extension 安装/启用逻辑？ | 确认 pi subagent extension 的加载机制，如果需要配置则补充到 in-scope 或明确标注"前提条件，超出本期范围" |
| 6 | SHOULD FIX | 验收标准 | §验收标准 | AC-1 "pi subagent extension 已安装并在 pi 启动时加载"——这是前提条件还是需要开发的交付物？如果是前提条件，不应作为 AC。如果需要开发安装逻辑，则缺实现细节 | 明确标注为前提条件（超出本期开发范围），或补充安装/加载的实现方案 |
| 7 | SHOULD FIX | 自包含性 | §已有基础设施 | pi subagent extension 的位置写的是 `~/GitApp/pi-mono/packages/coding-agent/examples/extensions/subagent/`，这是 pi 源码位置。但 spec 约束写"pi 源码改动在 out of scope"。Phase 2 agent 是否需要阅读这些文件？如果只是确认能力，标注"仅供参考"即可 | 在已有代码表中区分"需要修改的代码"和"仅供理解的参考代码" |
| 8 | SHOULD FIX | 歧义 | §行为约束 > Ask First | "agent 的 system prompt 是否需要在触发前展示给用户预览"——这个问题没有标记为 [AMBIGUOUS]，但它影响 SlashMenu 的交互流程。如果不预览，agent 选择器只需 name + description；如果预览，需要额外 UI | 标记 [AMBIGUOUS] 或直接做决策（建议：不预览，理由是 system prompt 通常很长且技术性强） |
| 9 | SHOULD FIX | 自包含性 | §已有基础设施 | agent 的"token 用量"展示（行为约束 Always 第 1 条）——subagent tool 的 output 中是否包含 token 用量数据？从 pi subagent extension 源码看，`AgentToolResult` 确实包含 usage 统计，但 EventAdapter 的 `tool_execution_end` 只提取了 `output`（文本）和 `error`，没有提取 usage。这是否需要在 EventAdapter 中增加 subagent 特有的字段提取？ | 明确：token 用量从哪里获取？是 subagent tool output 文本中解析？还是需要扩展 EventAdapter/tool_execution_end payload 增加 usage 字段？ |
| 10 | LOW | 一致性 | §目标 vs §行为约束 | 目标说"LLM 自动调用"是"零额外开发"，但行为约束 Ask First 提到"LLM 自动调用 subagent 时是否需要用户确认（extension 已有 confirmProjectAgents 机制）"。如果需要确认，那前端需要处理确认交互，就不是"零额外开发" | 确认 confirmProjectAgents 是否会在 tool_execution_start 事件中体现（通过 extension_ui_request）。如果是，说明已有的 message.tool_call_pending 处理逻辑已覆盖 |
| 11 | LOW | 自包含性 | §数据流 | 数据流中提到 "tool_execution_start/update/end 事件通过 RPC 流出"，但 EventAdapter 的 switch 中没有 `tool_execution_update` case——只有 `tool_execution_start` 和 `tool_execution_end`。subagent 执行过程中的中间进度更新（如子进程 stdout）是如何传递的？ | 确认 subagent 执行时是否有中间更新事件需要处理。如果没有，删除"update"避免误导 |
| 12 | LOW | 引用完整性 | §已有基础设施 | server.ts L232-252 标注了 agent CRUD handler 位置。经验证，实际行号约在 232-252 范围，准确。但 `loadAgents`/`saveAgents` 来自 `config-store.ts` 而非 server.ts 内联，spec 没有引用 config-store.ts | 如果 Phase 2 需要修改 agent 持久化逻辑，补充 config-store.ts 的位置 |

### 结论

需修改后重审。

### Summary

Spec 评审完成，第 1 轮，5 条 resolved issue，需重审。

主要问题集中在：
1. 核心 UI 交付物（结构化卡片）缺少 UI 规格
2. 手动触发的"可靠触发机制"与自然语言 prompt 方案之间存在矛盾
3. SlashMenu 类型系统扩展需求未在 spec 中标注
4. subagent extension 加载机制不明确
5. 验收标准中"视觉区分"不可量化

建议主 agent 优先解决 resolved issue #1-#4 后提交重审。
