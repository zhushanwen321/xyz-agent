# Test Review v1 — Agent Subagent Feature

## 评审记录
- 评审时间：2026-05-15 23:15
- 评审类型：测试文件 + E2E 测试报告独立评审
- 评审对象：10 个测试文件 + E2E 测试报告
- 评审轮次：第 1 轮

## 测试运行验证

实际运行测试（从正确的 working directory 使用对应的 vitest 配置）：

| Suite | Files | Tests | Pass | Fail |
|-------|-------|-------|------|------|
| Renderer (`src-electron/renderer/`) | 10 | 73 | 73 | 0 |
| Sidecar (`src-electron/sidecar/`) | 5 | 36 | 36 | 0 |
| **Total** | **15** | **109** | **109** | **0** |

E2E 报告中的 109/109 PASS 数据与实际运行一致。测试从项目根目录直接运行 `npx vitest run` 会失败（缺少 Vue 插件配置），但这是运行方式问题，不是测试代码问题。

## 实现文件 → 测试文件覆盖映射

| # | 实现文件 | 测试文件 | 状态 |
|---|---------|---------|------|
| 1 | `renderer/composables/useSlashCommands.ts` | `useSlashCommands.test.ts` (7) + `useSlashCommands-boundary.test.ts` (10) | ✅ 充分 |
| 2 | `renderer/composables/useChat.ts` | `useChat-subagent.test.ts` (5) + `useChat-subagent-boundary.test.ts` (8) | ✅ 充分 |
| 3 | `sidecar/src/server.ts` | `server-subagent.test.ts` (6) + `server-subagent-boundary.test.ts` (7) | ✅ 充分 |
| 4 | `renderer/components/chat/ToolRenderers/SubagentRenderer.vue` | `SubagentRenderer.test.ts` (9) | ⚠️ 缺少 running 状态测试 |
| 5 | `renderer/components/chat/ChatInput.vue` | `ChatInput-subagent.test.ts` (8) | ✅ 充分 |
| 6 | `renderer/components/panel/PaneSessionView.vue` | `PaneSessionView-subagent.test.ts` (7) | ✅ 充分 |
| 7 | `renderer/lib/register-tool-renderers.ts` | `register-tool-renderers.test.ts` (7) | ✅ 充分 |
| 8 | **`renderer/components/chat/SlashMenu.vue`** | **无测试文件** | ❌ 无测试 |

## 验收标准覆盖追踪

| AC | 描述 | 测试覆盖 | 状态 |
|----|------|---------|------|
| AC-1 | `SlashCommandSource` 类型扩展为三元 | useSlashCommands.test.ts 验证 source='agent' | ✅ |
| AC-2 | SlashMenu agent 条目 source 标签显示 "agent" | **仅 E2E grep 验证，无自动化测试** | ⚠️ |
| AC-3 | SlashMenu 仅展示 enabled agent | useSlashCommands.test.ts: "should only include enabled agents" | ✅ |
| AC-4 | 选择 agent 后预填 `/agent:name ` | ChatInput-subagent.test.ts: selectAgentCommand 测试 | ✅ |
| AC-5 | protocol 层可靠触发 subagent tool 调用 | useChat-subagent + server-subagent 全链路测试 | ✅ |
| AC-6 | register-tool-renderers 注册 SubagentRenderer | register-tool-renderers.test.ts | ✅ |
| AC-7 | SubagentRenderer Header 显示 agent name + 状态 | SubagentRenderer.test.ts: agent name 解析测试 | ✅ |
| AC-8 | SubagentRenderer Body 展示 task + output | SubagentRenderer.test.ts: task/output 测试 | ✅ |
| AC-9 | error 状态渲染 | SubagentRenderer.test.ts: data-status="error" 测试 | ✅ |
| AC-10 | LLM 自动调用使用 SubagentRenderer | **无自动化测试**（依赖 pi runtime，仅 G5 manual） | ⚠️ |
| AC-11 | 无 enabled agent 时不展示 agent 分类 | useSlashCommands.test.ts: 空 agents 数组测试（部分覆盖） | ⚠️ |

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | SHOULD FIX | 覆盖率 | SlashMenu.vue | `SlashMenu.vue` 修改了 source 标签的三分逻辑和样式（从二分改为 builtin/skill/agent 三分），但没有对应的组件级测试。当前仅通过 E2E report 中的 grep 检查覆盖 | 添加 `SlashMenu.test.ts`，mount 组件后传入不同 source 类型的 SlashCommand，验证标签文字分别为 "command"/"skill"/"agent"，以及对应的 CSS 类 |
| 2 | SHOULD FIX | 断言质量 | `ChatInput-subagent.test.ts` | 3 个测试用例（"no agent command"、"empty task"、"special characters"）的断言被包裹在 `if (emitted)` 中。如果 emit 事件未触发，测试不会失败而是静默通过 | 移除 `if (emitted)` 守卫，改为直接断言 `expect(emitted).toBeDefined()`，确保未 emit 时测试明确失败 |
| 3 | SHOULD FIX | 覆盖率 | `SubagentRenderer.test.ts` | 缺少 `status: 'running'` 的测试。组件有逻辑 `showOutput` 在 running 时不显示 output，但这个行为未被任何测试验证 | 添加测试：status 为 running 时 output 区域不应渲染（`pre` 元素不存在） |
| 4 | SHOULD FIX | 覆盖率 | `SubagentRenderer.test.ts` | 缺少 `status: 'running'` 时 header 区域的 spinner/状态指示器渲染验证。spec AC 要求显示 "执行状态指示器（spinner ✓ ✗）" | 添加 running/completed/error 三种状态的视觉指示器测试 |
| 5 | NOTE | 测试设计 | `SubagentRenderer.test.ts` | 所有 9 个 `it` 直接定义在文件顶层，没有 `describe` 包裹。功能上正常但影响测试报告的可读性 | 用 `describe('SubagentRenderer', () => { ... })` 包裹 |
| 6 | NOTE | 测试设计 | `useSlashCommands-boundary.test.ts` L131-139 | 两个测试用例名字描述矛盾："skill-agent name collision, keeping skill first" 和 "agent has name identical to skill but prefixed differently"。前者说去重保留 skill，后者说因为前缀不同所以两个都存在。测试逻辑是正确的（agent 命令名带 `agent:` 前缀所以不会与 skill 同名），但描述文字可能造成混淆 | 第二个测试描述改为 "should coexist when agent produces 'agent:name' and skill produces 'name' as distinct commands" |
| 7 | NOTE | 测试设计 | `server-subagent.test.ts` L123-143 | 测试 "should sanitize special characters" 断言了 `<>"&` 被移除，但没有验证移除后的 JSON 是否结构完整（可被 JSON.parse 解析） | 添加 `expect(() => JSON.parse(jsonMatch)).not.toThrow()` 类断言 |
| 8 | NOTE | 覆盖率 | 全局 | 无 EventAdapter 集成测试。spec 提到 event-adapter.ts 通用处理 tool_execution_start/end，但没有测试验证 subagent tool 的事件流经 EventAdapter 后是否正确到达前端。不过由于 EventAdapter 的处理是通用的（不区分 tool name），这更多是已有代码的测试问题而非新增代码 | 低优先级，可记录为后续改进 |
| 9 | NOTE | E2E 报告 | `e2e-test-report.md` | G2-G6 全部标记为 MANUAL，没有自动化 E2E 测试方案。Manual test checklist 步骤清晰但无法在 CI 中执行 | 考虑后续引入 Playwright 或 Spectron 自动化 E2E |

## 各测试文件详细评价

### 1. `useSlashCommands.test.ts` (7 tests) — 良好

**优点**：
- 正向路径完整：agent 命令生成、source 类型、action 结构、enabled 过滤、排序、向后兼容
- 断言具体：检查 `source`、`action.type`、`action.agentName`、`description`
- 工厂函数 `makeAgent`/`makeSkill` 设计合理

**不足**：
- 无不足

### 2. `useSlashCommands-boundary.test.ts` (10 tests) — 良好

**优点**：
- 覆盖了空名、特殊字符（空格/斜杠）、大量数据（100 agents）、去重边界、null/undefined 输入
- 对 agent 命令名前缀 `agent:` 与 skill 命令名的关系验证到位
- 排序验证在边界条件下也做了

**不足**：
- 见问题 #6（描述文字混淆）

### 3. `useChat-subagent.test.ts` (5 tests) — 良好

**优点**：
- 核心功能全覆盖：有/无 subagent 时的 payload 形状、字段传递、向后兼容
- 精确断言 payload keys（AC-4: `Object.keys(msg.payload).sort()` 验证不含多余字段）
- undefined subagent 等同于不传

**不足**：
- 无不足

### 4. `useChat-subagent-boundary.test.ts` (8 tests) — 良好

**优点**：
- 长字符串（2000字符）、Unicode、XML 危险字符在 composable 层的透传验证
- 空 sessionId / null sessionId 不发送消息
- 快速连续调用、交替有无 subagent 的调用序列

**不足**：
- XML 危险字符的注释正确说明了 "sanitization is the server's responsibility, not the composable's"，职责划分清晰

### 5. `server-subagent.test.ts` (6 tests) — 良好

**优点**：
- 真实 WebSocket 连接测试（不是纯单元 mock）
- XML 结构验证完整：`<tool_call tool="subagent">` 开闭标签、JSON 内容
- 特殊字符清理验证
- 日志输出验证（logSpy）
- 向后兼容验证（无 subagent 时发送原始 content）

**不足**：
- 见问题 #7（sanitize 后的 JSON 解析完整性）

### 6. `server-subagent-boundary.test.ts` (7 tests) — 良好

**优点**：
- XML 注入防御测试到位（agent/task 中的 `<>"&` 都被剥离）
- 换行符保留验证
- 空 agent/task 的边界情况
- 长字段（500/1000 字符）的结构完整性（验证 JSON 可解析）
- 单引号保留（不在 sanitize regex 中）

**不足**：
- 无不足

### 7. `SubagentRenderer.test.ts` (9 tests) — 有缺口

**优点**：
- JSON 字符串和对象两种 input 格式的解析
- task 描述、output 渲染、error 样式、无效 input 降级
- mode 标签（single/parallel/chain）

**不足**：
- 见问题 #3、#4、#5

### 8. `ChatInput-subagent.test.ts` (8 tests) — 有弱断言

**优点**：
- 完整的 SlashMenu 选择 → 输入 → 发送流程模拟
- task 前缀剥离验证、skill 命令不产生 subagent、isStreaming 阻止发送
- protocol 命令（compact）走 send-command 通道

**不足**：
- 见问题 #2（`if (emitted)` 静默通过）

### 9. `PaneSessionView-subagent.test.ts` (7 tests) — 良好

**优点**：
- 完整的 send 事件 → sendMessage 调用传递链路
- 空 subagent 对象、undefined 字段的容错
- user message 写入 chatStore 验证
- 空 sessionId 不调用 sendMessage

**不足**：
- 无不足

### 10. `register-tool-renderers.test.ts` (7 tests) — 良好

**优点**：
- 使用 `vi.resetModules()` 隔离模块级 Map 状态
- 注册完整性（所有 6 个 tool name）、幂等性、覆盖性、区分性
- 未注册 tool 返回 undefined

**不足**：
- 无不足

## E2E 测试报告评价

### 优点
- G1 基础设施验证的 18 个自动化检查全部通过
- Manual test checklist（G2-G6）步骤清晰，可操作性高
- Code-level verification 通过 grep 方式验证了所有关键接口的存在性

### 不足
- G2-G6 全部为 MANUAL，无任何自动化 E2E 测试
- 报告声称 "109/109 PASS" 但未记录具体的测试运行命令，导致从根目录运行时失败
- 缺少 performance/stress 维度（如大量 agent 列表的 SlashMenu 渲染性能）

## 结论

**通过，有建议项**

测试整体质量较高。109 个测试全部通过。正向路径、边界条件、错误路径的覆盖充分。核心数据流（前端 composable → WS → sidecar server → XML prompt）的每层都有独立测试。

主要缺口是 SlashMenu.vue 的组件级测试缺失（仅有 grep 级验证），以及 SubagentRenderer 缺少 running 状态测试和 ChatInput 的弱断言。这些不阻塞交付，但建议在后续迭代中补充。

### Summary

测试评审完成，第 1 轮，0 条 MUST-FIX（无阻塞项），4 条 SHOULD FIX，5 条 NOTE。测试全部通过（109/109），建议补充 SlashMenu 组件测试、SubagentRenderer running 状态测试、修复 ChatInput 弱断言。
