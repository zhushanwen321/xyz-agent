# Plan 评审 v2

## 评审记录
- 评审时间：2026-05-15 20:30
- 评审类型：Plan 独立评审（v1 修复后重审）
- 评审对象：plan.md（对照 spec.md）
- 评审轮次：第 2 轮

## v1 问题修复验证

### Fix 1: T3 不再使用自然语言 prompt → XML `<tool_call />` 结构化格式

**已修复。** T3 代码块已替换为：

```ts
const agentPrompt = `<tool_call tool="subagent">\n{"agent":"${safeAgent}","task":"${safeTask}"}\n</tool_call />`
```

不再使用自然语言指令。同时对 `<>"&` 做了字符转义。plan 还在"XML 方案说明"中解释了选择理由和备选方案。

**判定：修复充分。**

### Fix 2: T1/T2 不再交叉修改 useSlashCommands.ts → T1 统一处理

**已修复。** T1 现在涵盖三处改动：
- `useSlashCommands.ts`：类型扩展 + `mergeSkillCommands` 签名变更 + agent 映射逻辑
- `SlashMenu.vue`：标签三分逻辑 + 颜色
- `ChatInput.vue`：更新 `mergeSkillCommands` 调用 + handleSlashSelect agent 分支

T2 的文件变更表不再包含 `useSlashCommands.ts`，消除了同一文件被两个 task 交叉修改的问题。

**判定：修复充分。**

### Fix 3: T2 完整数据流 ChatInput → PaneSessionView → useChat → WS → sidecar

**已修复。** T2 现在是独立的 task，专门处理前端到 sidecar 的数据传递链路，覆盖三个文件：
- `ChatInput.vue`：handleSend 增加 `case 'agent'`，emit 携带 `subagent` 字段
- `PaneSessionView.vue`：handleSend 透传 subagent
- `useChat.ts`：sendMessage 签名扩展支持可选 `subagent` 参数

plan 还在注释中明确了 T2/T3 的共享契约：`{ content: string, subagent?: { agent: string; task: string } }`。

**判定：修复充分。**

### Fix 4: SubagentRenderer 在 body 显示 agent name（非 header）

**已修复。** T4 明确说明："Agent name 在 body 区域展示（ToolCallCard header 固定显示 toolName 'subagent'，不可覆盖）"。并提供了 ASCII 图示意 header 和 body 的分工。这与 ToolCallCard.vue 的实际结构一致（header 显示 `toolCall.toolName`，body 区域通过 `<component :is="rendererComp" :tool-call="toolCall" />` 交给自定义渲染器）。

**判定：修复充分。**

### Fix 5: SlashCommandAction 使用 `agentName`（非 `agentId`）

**已修复。** T1 类型定义改为 `{ type: 'agent'; agentName: string }`，并在注释中说明"pi subagent tool 需要的是 name，不是 id"。`mergeSkillCommands` 中 agent 命令映射也使用 `agentName: a.name`。整条链路（action 存储 → ChatInput handleSend → WS payload → sidecar 构造 XML）都使用 agent name。

**判定：修复充分。**

### Fix 6: ChatInput.vue 明确包含更新 mergeSkillCommands 调用

**已修复。** T1 的 ChatInput.vue 改动项 (a) 明确写出：
```ts
// Before: mergeSkillCommands(providerStore.skills)
// After: mergeSkillCommands(providerStore.skills, providerStore.agents)
```
定位到约 L127 行。

**判定：修复充分。**

---

## Spec 覆盖矩阵

| Spec In Scope 项 | Plan Task | 覆盖状态 | 说明 |
|-----------------|-----------|---------|------|
| 1. 基础设施：pi subagent extension 可用 | T0 | ✅ | 验证步骤明确，验收标准改为检查文件存在 + pi 日志 |
| 2. Agent 发现同步 | T1 | ✅ | 通过 providerStore.agents 动态获取，合并到 SlashMenu |
| 3. 用户手动触发（SlashMenu + 触发机制） | T1+T2+T3 | ✅ | T1 UI 选择 → T2 数据传递 → T3 sidecar 处理 |
| 4. LLM 自动调用 | 无 task | ✅ | spec 明确"零额外开发" |
| 5. 聊天内渲染（SubagentRenderer） | T4 | ✅ | 新建渲染组件 + 注册到 registry |
| 6. 事件适配 | 无 task | ✅ | event-adapter.ts 已通用处理 |

---

## 依赖链验证

```
T0 → T1 → T2 → T3 → T4（严格串行）
```

依赖合理性分析：
- **T0 → T1**：T0 验证基础设施，T1 依赖 agent 数据可用。合理。
- **T1 → T2**：T1 定义 SlashCommandAction agent 类型和 mergeSkillCommands 签名，T2 使用这些类型构造 emit payload。合理。
- **T2 → T3**：T2 定义前端发送的 payload 格式（含 `subagent` 字段），T3 在 sidecar 消费该格式。plan 明确标注了共享契约。合理。
- **T3 → T4**：T3 确保侧端能触发 subagent tool call，T4 渲染对应的 tool call 事件。弱依赖（T4 的渲染逻辑不依赖 T3 的触发逻辑），但串行无害。

**判定：依赖链正确。**

---

## 工作量验证

| Task | Plan 估计 | 代码库验证 | 判定 |
|------|----------|-----------|------|
| T0 | 0 行 | 环境验证脚本 | 合理 |
| T1 | ~80 行 | useSlashCommands.ts ~25 行类型/逻辑 + SlashMenu.vue ~10 行 + ChatInput.vue ~20 行 = ~55 行 | 估计略高但合理 |
| T2 | ~50 行 | ChatInput.vue ~8 行 + PaneSessionView.vue ~10 行 + useChat.ts ~8 行 = ~26 行 | 估计偏高，但包含注释和空行，可接受 |
| T3 | ~30 行 | server.ts ~15 行改动 | 合理 |
| T4 | ~90 行 | SubagentRenderer.vue ~70 行 + register-tool-renderers.ts ~3 行 = ~73 行 | 合理 |
| **总计** | **~250 行** | 实际 ~170 行代码 | 概览表写 ~600 行，但细看各 task 合计约 250 行代码。概览表的 600 行估计偏高 |

**判定：各 Task 行数估计合理。概览表的 ~600 行总量含 buffer，不构成问题。**

---

## 发现的新问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **SHOULD FIX** | T2 emit 签名变更 | T2 §ChatInput.vue | ChatInput.vue 当前 emit 类型定义为 `send: [payload: { content: string; skillName?: string }]`。T2 新增 `subagent?` 字段后，emit 类型需扩展为 `{ content: string; skillName?: string; subagent?: { agent: string; task: string } }`。plan 在代码块中展示了 emit 调用的内容，但没有明确写出需要修改 `defineEmits` 的类型签名。 | 在 T2 的 ChatInput.vue 改动中补充：修改 `defineEmits` 的 `send` 事件类型，增加 `subagent` 可选字段。同时 PaneSessionView.vue 的 `handleSend` 函数签名也需要从 `payload: { content: string; skillName?: string }` 扩展为包含 `subagent?` 字段。plan T2 §2 对 PaneSessionView 的描述是"透传 subagent"的注释，但没有给出具体代码改动和类型修改，略显模糊。 |
| 2 | **SHOULD FIX** | T3 XML 注入风险 | T3 代码块 | plan 对 `<>"&` 做了 `replace(/[<>"&]/g, '')` 清理，但这只是**删除**这些字符，不是转义。如果用户的 task 包含 `"analyze <div> vs &"` 等 HTML/XML 相关文本，清理后会变成 `"analyze div vs "`，丢失语义。对于 JSON 字符串内的值，更安全的做法是转义（`&amp;`、`&lt;`）而非删除。 | 考虑改用 JSON 序列化方案：`const args = JSON.stringify({ agent: subagent.agent, task: subagent.task })` 然后将 JSON 字符串嵌入 XML 标记中。JSON.stringify 自动处理引号和特殊字符转义，不会丢失语义。 |
| 3 | **SHOULD FIX** | T1 SlashMenu.vue 标签三分位置 | T1 §2 | plan 说改动在 L23-27，但代码库中 SlashMenu.vue 的标签逻辑在 L23 行是 `<span>` 的 `:class` 绑定，L24-25 是条件类，然后 `>{{ cmd.source === 'builtin' ? 'command' : 'skill' }}</span>` 在同一行。plan 的 before/after 代码块准确描述了改动，但位置标注"SlashMenu.vue L23-27"与实际行数可能有偏差（取决于换行）。这是微小问题，不影响实现。 | 无需修改。 |
| 4 | **NOTE** | T2 PaneSessionView 具体改动 | T2 §2 | PaneSessionView.vue 的 handleSend 当前签名是 `function handleSend(payload: { content: string; skillName?: string })`，内部调用 `sendMessage(payload.content)`。T2 需要修改为：(1) payload 类型增加 `subagent?`；(2) 调用 `sendMessage` 时传递 subagent 参数。plan §2 只写了一句注释"需要检查当前 handleSend 的 payload 类型定义是否需要扩展"，没有给出具体代码。与 T2 §1 和 §3 的详细代码块相比，这部分描述偏弱。 | 建议补充 PaneSessionView handleSend 的具体代码改动，至少给出改后的函数签名和 sendMessage 调用方式。 |
| 5 | **NOTE** | T2 useChat.sendMessage 签名变更影响范围 | T2 §3 | plan 将 sendMessage 从 `(content: string)` 改为 `(content: string, subagent?: {...})`。当前 PaneSessionView.vue L89 是唯一调用方 `sendMessage(payload.content)`，签名变更向后兼容。但 useChat.ts 是 composable，如果未来有其他调用方也需要注意。当前无风险。 | 无需修改，风险极低。 |

---

## 结论

**通过**

v1 的 6 条 resolved issue 全部修复到位。修复质量高，每条都有具体的代码块或设计说明支撑。本轮发现 3 条 SHOULD FIX（emit 类型签名补全、XML 转义策略、PaneSessionView 改动细节），均为改进建议，不阻塞实现。

### Summary

Plan 评审完成，第 2 轮，0 条 resolved issue，3 条 SHOULD FIX，2 条 NOTE。通过。
