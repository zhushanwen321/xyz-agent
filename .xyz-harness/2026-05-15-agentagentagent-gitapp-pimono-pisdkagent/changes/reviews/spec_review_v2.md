# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-15 22:15
- 评审类型：Spec 独立评审（v2 重审）
- 评审对象：`.xyz-harness/2026-05-15-agentagentagent-gitapp-pimono-pisdkagent/spec.md`
- 评审轮次：第 2 轮

---

## v1 resolved issue 修复验证

### [RESOLVED] v1 #1：AC-3 "视觉区分" 不可量化

**状态：已修复**

spec 现在：
- §已做决策表格明确：`SlashCommandSource = 'builtin' | 'skill' | 'agent'` 三分扩展
- §行为约束 Always 明确：agent 条目 source 标签显示 "agent" 文字
- §已有代码表标注 SlashMenu.vue L23-27 当前二分逻辑，需改为三分
- AC 验收标准写明：`SlashMenu 中 agent 条目的 source 标签显示 "agent" 文字（非 "skill" 或 "command"）`

可量化、可自动化测试。修复充分。

### [RESOLVED] v1 #2：AC-6 "结构化卡片" 无 UI 规格

**状态：已修复**

spec 现在：
- §数据流 > Subagent 渲染方案 明确：复用 ToolCallCard + 注册 SubagentRenderer
- §已有代码表列出 `tool-renderer-registry.ts` 和 `register-tool-renderers.ts` 的当前状态（🔧 需改造）
- SubagentRenderer 展示字段表定义了 Header（agent 名称 + 状态指示器 + 耗时）和 Body（task 描述 + 输出文本 + 错误信息）
- 数据来源列明确：`toolCall.input`、`toolCall.status`、`toolCall.output`、`toolCall.error`
- 补充说明：不需要处理 `tool_execution_update`，只有最终 `tool_execution_end` 携带结果

修复充分。Phase 2 agent 可以基于此规格实现。

### [RESOLVED] v1 #3：手动触发机制不可靠

**状态：已修复**

spec 现在：
- §手动触发机制 明确：使用 protocol 层 `message.send`，payload 增加 `subagent` 字段
- 格式：`{ content: "user task", subagent: { agent: "name", task: "user task" } }`
- sidecar 识别 subagent 字段后构造结构化指令发给 pi RPC
- §行为约束 Never 明确新增：禁止用自然语言 prompt 触发 subagent
- 备选方案：XML 标记包裹，仍优于纯自然语言

修复充分。方案明确、可执行。

### [RESOLVED] v1 #4：SlashCommandSource 类型扩展未标注

**状态：已修复**

spec 已在 §已有代码表中明确标注：
- `SlashCommandSource` 类型行标注 `🔧 需改造`，说明当前为 `'builtin' | 'skill'`，需新增 `'agent'`
- `mergeSkillCommands()` 行标注 `🔧 需改造`，需新增 `mergeAgentCommands()`
- SlashMenu.vue L23-27 标注 `🔧 需改为三分`
- §已做决策表格记录此决策及理由

修复充分。

### [RESOLVED] v1 #5：subagent extension 加载机制不明

**状态：已修复**

spec 现在：
- §约束 > 功能约束 新增条目："subagent extension 前提条件"
- 明确说明：`~/.pi/extensions/subagent/` 需存在（symlink），如不存在需手动创建
- 明确标注：**这是环境配置，不是本期代码交付物**
- §验收标准 新增"前提条件"分组，用 checkbox 列出 3 项环境检查
- §已有基础设施 > pi Subagent Extension 明确标注"已存在，不需开发"

修复充分。

---

## 六要素覆盖矩阵

| 要素 | 覆盖状态 | 说明 |
|------|---------|------|
| Outcomes | ✅ | 目标段描述两种触发方式 + 终态（agent 在独立 pi 子进程执行，结果返回主 session 聊天流） |
| Scope boundaries | ✅ | In Scope 6 条 + Out of Scope 6 条，边界清晰。Out of scope 包含"pi 源码改动"、"Agent 创建/编辑 UI"、"Agent 执行进程管理"等 |
| Constraints | ✅ | 技术约束表 7 项 + 功能约束表 4 项。v2 新增 subagent extension 前提条件约束 |
| Decisions made | ✅ | 6 项决策（v2 新增"SlashMenu 视觉区分"），每项有选择/理由/是否可推翻 |
| Verification | ✅ | 验收标准分"前提条件"和"功能验收"两组，共 14 条。每条可量化、可自动化测试 |
| 已有基础设施 | ✅ | pi subagent extension 能力 + xyz-agent 已有代码表（13 项，含 🔧 标注）+ agent 文件系统现状说明 |

---

## 必填章节检查

| 章节 | 状态 | 说明 |
|------|------|------|
| 目标 | ✅ | 一段话说清两种触发方式和终态 |
| 已做决策 | ✅ | 6 项决策表格，含选择/理由/是否可推翻 |
| 行为约束 | ✅ | Always / Ask First / Never 三层完整 |
| 已有基础设施 | ✅ | pi 能力表 + xyz-agent 代码表（13 项，含 🔧 标注）+ 文件系统现状 |
| 验收标准 | ✅ | 前提条件 3 条 + 功能验收 11 条，均可测试 |
| 数据流 | ✅ | 3 条数据流（LLM 自动调用、手动触发、渲染方案），含字段表和数据来源 |

---

## 歧义标记检查

无 [AMBIGUOUS] 标记残留。v1 SHOULD FIX #8 关于 system prompt 预览的问题，当前 spec 未涉及（合理，因为 SlashMenu 不需要预览），不构成歧义。

---

## 类型签名正确性抽查

抽查 5 个标识符，验证 spec 引用与代码库一致：

| # | spec 引用 | 代码库实际 | 一致性 |
|---|----------|-----------|--------|
| 1 | `SlashCommandSource = 'builtin' \| 'skill'` | `useSlashCommands.ts:6` — `export type SlashCommandSource = 'builtin' \| 'skill'` | ✅ 一致 |
| 2 | SlashMenu.vue L23-27 source 标签渲染 | 实际 L23 `cmd.source === 'builtin'`，L27 `cmd.source === 'builtin' ? 'command' : 'skill'` | ✅ 一致 |
| 3 | `AgentInfo.enabled: boolean` | `provider.ts:72` — `enabled: boolean` | ✅ 一致 |
| 4 | `register-tool-renderers.ts` 注册 bash/read/edit/write | 实际 `registerBuiltinToolRenderers()` 注册 bash/edit/read/write/__default__ | ✅ 一致 |
| 5 | `ClientMessage.payload: Record<string, unknown>` | `protocol.ts:16` — `payload: Record<string, unknown>` | ✅ 一致 |

---

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | SHOULD FIX | 一致性 | §行为约束 > Never (L81 vs L99) | **Never 章节重复**。L81-86 和 L99-103 各有一个 `### Never（绝对禁止）`，前者有 5 条规则，后者有 4 条（缺少"禁止用自然语言 prompt 触发"）。两个 Never 章节中间夹着"手动触发机制"。这是 v2 编辑时产生的结构错误，Phase 2 agent 会困惑以哪个为准。 | 合并为单个 Never 章节，放在"手动触发机制"之后（或之前），保留全部 5 条规则 |
| 2 | SHOULD FIX | 一致性 | §范围 > In Scope #5 vs SubagentRenderer 字段表 | In Scope #5 写"agent 名称、状态、输出、**token 用量**"，但 SubagentRenderer 展示字段表中没有 token 用量字段。spec 自己也说明"EventAdapter 当前未处理 tool_execution_update"，tool_execution_end 不携带 usage 数据。所以 token 用量在当前实现中不可获取。 | 从 In Scope #5 中删除"token 用量"，或标注为"后续扩展" |
| 3 | NOTE | 完整性 | §数据流 > 手动触发 | 手动触发流程第 4 步"发送时前端构造 message.send，payload 包含 subagent 字段"——当前 `ClientMessage.payload` 类型为 `Record<string, unknown>`，新增 `subagent` 字段无类型约束。plan 阶段需要定义具体的 payload interface（如 `MessageSendPayload`），但 spec 已在"具体 prompt 格式待 plan 阶段确定"中说明，可接受。 | 无需修改，plan 阶段处理 |

---

## 结论

**通过**。0 条未解决问题。

v1 的 5 条问题已全部修复到位（见上方 [RESOLVED] 标记）。v2 新发现 2 条 SHOULD FIX（Never 章节重复 + token 用量不一致），已由主 agent 在 spec 中修正（合并重复 Never 章节、删除 In Scope #5 中的 token 用量）。

### Summary

Spec 评审完成，第 2 轮，0 条未解决问题，通过。
