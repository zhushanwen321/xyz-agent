# Code Review v2 — Agent Subagent 使用（复审）

## 评审记录
- 评审时间：2026-05-15
- 评审类型：代码复审（v1 修复验证 + 残留问题检查）
- 评审范围：1 fix commit (e1b91bd), 6 files changed
- 评审轮次：第 2 轮
- 前置评审：code_review_v1.md（6 resolved issue, 5 SHOULD FIX）

---

## v1 resolved issue 修复验证

| # | v1 问题 | 修复状态 | 验证结果 |
|---|---------|---------|---------|
| 1 | SlashMenu.vue — source 标签三分逻辑 | **已修复** | 三元表达式 `cmd.source === 'builtin' ? 'command' : cmd.source === 'skill' ? 'skill' : 'agent'` 正确。agent 标签使用 `bg-blue-500/10 text-blue-500` 蓝色样式。 |
| 2 | ChatInput.vue — mergeSkillCommands/agent 分支 | **已修复** | (a) `mergeSkillCommands(providerStore.skills, providerStore.agents)` 传入 agents。(b) `handleSlashSelect` 有 `cmd.action.type === 'agent'` 分支。(c) `handleSend` switch 有 `case 'agent'` 分支，emit 包含 `subagent` 字段。 |
| 3 | PaneSessionView.vue — handleSend 传递 subagent | **已修复** | 签名扩展为含 `subagent?`，`sendMessage(payload.content, payload.subagent)` 正确传递。 |
| 4 | server.ts 缩进 | **已修复** | `message.send` case 块缩进现在为 8sp case + 10sp body，与周围 `session.rename` (8sp case + 10sp body) 一致。 |
| 5 | useSlashCommands.ts 缩进 | **已修复** | `mergeSkillCommands` 函数体从 2sp 改为 4sp，与同文件其他函数一致。 |
| 6 | useChat.ts 缩进 | **已修复** | `sendMessage` 函数体从 2sp 改为 4sp，与 `abort()` 等函数一致。 |

**v1 resolved issue 结论：6/6 已修复。**

---

## v1 SHOULD FIX 状态复查

| # | v1 问题 | 当前状态 | 说明 |
|---|---------|---------|------|
| 7 | SubagentRenderer 硬编码 oklch 颜色 | **未修复** | 仍为 `bg-[oklch(0.65_0.15_250)]` 和 `text-[oklch(0.55_0.15_250)]`。 |
| 8 | SubagentRenderer max-height 180 vs spec 300 | **未修复** | 仍为 `max-h-[180px]`。 |
| 9 | useSlashCommands.test.ts `as any` | **未修复** | 仍为 6 处 `as any`。 |
| 12 | SubagentRenderer error 状态无红色边框 | **未修复** | `data-status="error"` 仍无对应样式。 |
| 13 | server.ts XML 注入用删除而非转义 | **未修复** | 仍为 `replace(/[<>"&]/g, '')`。 |

---

## 新发现问题

### 缩进类

| # | 优先级 | 文件 | 行号 | 描述 |
|---|--------|------|------|------|
| 14 | resolved issue | ChatInput.vue | L217-228 | **switch case 缩进不一致**：`case 'local'` 在 6sp、body 在 8sp，而 `case 'skill'` 和 `case 'agent'` 在 4sp、body 也在 4sp。同一个 switch 内两种缩进级别，且 skill/agent case body 与 case 关键字同级，不可读。 |
| 15 | resolved issue | ChatInput.vue | L187-196 | **else 块内缩进错误**：`else { ... }` 内的代码（`activeCommand.value = cmd`、`if (cmd.action.type === 'agent')` 等）缩进为 2sp，与 `else` 关键字同级。内部代码应多缩进 2sp。`nextTick` 回调体内（L191-192）也是 4sp，与 `nextTick(() => {` (L190) 同级，无额外缩进。 |
| 16 | resolved issue | SlashMenu.vue | L23-28 | **:class 三元表达式缩进混乱**：`:class="[` 起始在 10sp，但三元表达式内容跳到 6sp（掉了 4sp），闭合 `]"` 也在 6sp。结果：属性内部缩进比属性起始少 4sp。`>` 闭合标签（L29）跳到 4sp，而 `<span` 开标签在 8sp。 |
| 17 | resolved issue | PaneSessionView.vue | L86-91 | **addMessage 参数缩进错误**：`addMessage({` 后面的对象属性（id, role, content 等）缩进为 2sp，与 `chatStore.addMessage({` 同级。应为 4sp。对比同文件 L111-L120 `handleLocalAction` 中的 `addMessage`，属性在 6sp（比 `chatStore.addMessage({` 多 4sp）。 |

### 功能/正确性类

| # | 优先级 | 文件 | 行号 | 描述 |
|---|--------|------|------|------|
| 18 | resolved issue | server.ts | L377 | **XML 标签未闭合**：`</tool_call` 缺少 `>`，实际输出为 `</tool_call`。plan 中明确要求 `</tool_call />`（自闭合格式），两者都不匹配。当前生成的是无效 XML，pi 端 LLM 可能无法正确解析 subagent 指令。测试中的 `.toContain('</tool_call')` 是子串匹配所以通过了，但这不证明 XML 有效。 |
| 19 | SHOULD FIX | SlashMenu.vue + ChatInput.vue | 多处 | **`bg-blue-500/10 text-blue-500` 硬编码颜色**：agent 标签使用 Tailwind 的 blue-500 色值硬编码。项目规范禁止硬编码颜色，应使用 CSS 变量（如 `--agent-bg`、`--agent-text`）或语义类。与 v1 #7 (SubagentRenderer oklch) 属同类问题，但这是新增代码。 |
| 20 | SHOULD FIX | SubagentRenderer.test.ts | 全文 | **测试无法运行**：`happy-dom` 未安装为依赖，导致 `npm run test` 时 SubagentRenderer 测试因 `ERR_MODULE_NOT_FOUND` 失败。其他 5 个测试套件（35 个测试）全部通过。 |

---

## 各文件详细评审

### ChatInput.vue（fix commit 修改）

**已正确实现**：
- emit 签名扩展含 `subagent?` 字段 ✅
- `mergeSkillCommands` 传入 agents ✅
- `handleSlashSelect` agent 分支：设置 text + 聚焦 ✅
- `handleSend` agent case：构造 subagent payload 并 emit ✅

**问题**：
- switch case 缩进不一致（#14）— 同一 switch 内两种缩进
- else 块内无缩进（#15）

### SlashMenu.vue（fix commit 修改）

**已正确实现**：
- 三元 source 标签逻辑：builtin→command, skill→skill, agent→agent ✅
- agent 使用蓝色视觉区分 ✅

**问题**：
- `:class` 属性内缩进混乱（#16）

### PaneSessionView.vue（fix commit 修改）

**已正确实现**：
- handleSend 签名扩展 ✅
- sendMessage 传递 subagent ✅

**问题**：
- addMessage 对象参数缩进错误（#17）

### server.ts（fix commit 修改）

**已正确实现**：
- case 块缩进与周围一致 ✅
- if/else 内部缩进正确 ✅

**问题**：
- `</tool_call` 缺少闭合 `>`（#18）

### useSlashCommands.ts（fix commit 修改）

**已正确实现**：
- 4sp 函数体缩进 ✅
- map 回调内对象属性正确缩进 ✅

### useChat.ts（fix commit 修改）

**已正确实现**：
- 4sp 函数体缩进 ✅

---

## 完整数据链路验证

用户手动触发 agent 的完整链路：

1. **SlashMenu** 展示 agent 命令（`agent:xxx`），蓝色标签 ✅
2. **ChatInput.handleSlashSelect** 识别 `action.type === 'agent'`，设置 text ✅
3. **ChatInput.handleSend** `case 'agent'` 构造 `{ content, subagent: { agent, task } }` emit ✅
4. **PaneSessionView.handleSend** 接收含 subagent 的 payload，传给 `sendMessage` ✅
5. **useChat.sendMessage** 将 subagent 加入 WS payload ✅
6. **server.ts** 识别 subagent 字段，构造 XML 指令 ⚠️（XML 未闭合）
7. **SubagentRenderer** 渲染 tool_call 结果 ✅

链路功能完整，但 XML 闭合问题（#18）可能导致 pi 端无法正确解析。

---

## 问题汇总

| # | 优先级 | 文件 | 描述 |
|---|--------|------|------|
| 14 | resolved issue | ChatInput.vue | switch case 缩进不一致：skill/agent case 4sp vs local/protocol 6sp |
| 15 | resolved issue | ChatInput.vue | else 块内部代码无缩进（2sp 同级 else） |
| 16 | resolved issue | SlashMenu.vue | `:class` 三元表达式缩进混乱，属性内容比属性起始少 4sp |
| 17 | resolved issue | PaneSessionView.vue | addMessage 对象属性缩进 2sp（与函数调用同级） |
| 18 | resolved issue | server.ts | XML 标签 `</tool_call` 缺少闭合 `>`，plan 要求 `</tool_call />` |
| 19 | SHOULD FIX | SlashMenu + ChatInput | `bg-blue-500/10 text-blue-500` 硬编码颜色（+ v1 遗留 SubagentRenderer oklch） |
| 20 | SHOULD FIX | SubagentRenderer.test.ts | 测试因缺少 happy-dom 依赖无法运行 |

> v1 遗留 SHOULD FIX（#7 oklch、#8 max-height、#9 as any、#12 error 边框、#13 XML 注入）均未修复，不在本表重复列出。

---

## 结论

**需修改后重审**

fix commit 正确实现了 v1 的 6 个 resolved issue 的功能部分（三分逻辑、agent 分支、subagent 传递），核心数据链路已打通。但修复过程中引入了新的缩进问题（#14-17），以及 XML 未闭合的功能缺陷（#18）。

**5 resolved issue remaining**（#14-18），2 新 SHOULD FIX（#19-20），5 遗留 SHOULD FIX（v1 #7/8/9/12/13）。

### Summary

Code review v2 完成，v1 的 6 个 resolved issue 全部功能修复已验证通过，但修复引入 5 个新 resolved issue（4 个缩进 + 1 个 XML 未闭合），需修改后重审。
