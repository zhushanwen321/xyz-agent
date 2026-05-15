# E2E 测试计划评审 v1

## 评审记录
- 评审时间：2026-05-15
- 评审类型：E2E 测试计划评审
- 评审对象：e2e-test-plan.md（对照 spec.md + plan.md）
- 评审轮次：第 1 轮

---

## 1. Spec AC → TC 映射覆盖率

| Spec AC | 对应 TC | 覆盖状态 |
|---------|---------|----------|
| `SlashCommandSource` 类型扩展为 `'builtin' \| 'skill' \| 'agent'` | TC-2-01（source 标签三分） | ⚠️ 间接覆盖。类型扩展是代码层面验证，E2E 只验证 UI 表现。可接受。 |
| SlashMenu agent 条目 source 标签显示 "agent" | TC-2-01 | ✅ |
| SlashMenu 仅展示 enabled agent | TC-2-02 | ✅ |
| 选择 agent 后输入框预填 `/agent:name ` | TC-2-03 | ✅ |
| 发送的消息通过 protocol 层可靠触发 subagent tool 调用 | TC-3-01 + TC-3-02 + TC-3-03 | ✅ |
| `register-tool-renderers.ts` 注册了 SubagentRenderer | TC-4-01（隐含：如果没注册，ToolCallCard 会 fallback 到 default renderer，SubagentRenderer 特有内容不显示） | ⚠️ 间接覆盖 |
| SubagentRenderer 从 `toolCall.input` 提取 agent 名称，Header 显示 | TC-4-03 | ✅ |
| SubagentRenderer Body 展开显示 task 描述和输出文本 | TC-4-01 + TC-4-02 | ✅ |
| agent 执行错误时展示错误信息（红色边框 + error text） | TC-4-04 | ✅ |
| LLM 自动调用同样使用 SubagentRenderer | TC-4-05 | ✅ |
| 无 enabled agent 时 SlashMenu 不展示 agent 分类，不报错 | TC-2-04 | ✅ |

**覆盖结论**：所有 Spec AC 均有对应 TC，覆盖充分。

---

## 2. Plan Task → TC 映射覆盖率

| Plan Task | 对应 TC | 覆盖状态 |
|-----------|---------|----------|
| T0: 基础设施验证 | TC-1-01 + TC-1-02 + TC-1-03 | ✅ 前置检查 + G1 完全对应 |
| T1: SlashMenu agent 命令 + 类型扩展 | TC-2-01~04 | ✅ 四个 TC 全覆盖 T1 的 5 个验收标准 |
| T2: 前端→Sidecar 数据链路 | TC-3-01 + TC-3-04 | ✅ 正向和反向（无 subagent 字段）都覆盖 |
| T3: Sidecar 手动触发处理 | TC-3-02 + TC-3-03 + TC-6-03 | ✅ 覆盖 XML 构造 + pi 执行 + 特殊字符处理 |
| T4: SubagentRenderer 组件 | TC-4-01~05 + TC-6-04 | ✅ 状态渲染 + agent name + 长输出 |

**覆盖结论**：每个 Plan Task 都有对应 TC 覆盖其验收标准。

---

## 3. 验证层级适当性

| TC | 验证层 | 评估 |
|----|--------|------|
| TC-1-01 | L1-WS | ✅ 合理——sidecar 日志确认 extension 加载 |
| TC-1-02 | L1-WS | ✅ 合理——pi 日志确认 tool 注册 |
| TC-1-03 | L2-DOM | ✅ 合理——Settings UI 验证 |
| TC-2-01~04 | L2-DOM | ✅ 合理——纯 UI 验证 |
| TC-3-01 | L1-WS | **⚠️ 见 MUST FIX #1** |
| TC-3-02 | L1-WS | **⚠️ 见 MUST FIX #2** |
| TC-3-03 | L1-WS | ✅ 合理——WS 事件验证 |
| TC-3-04 | L1-WS | ✅ 合理——反向验证 |
| TC-4-01~05 | L2-DOM | ✅ 合理——渲染验证 |
| TC-5-01~02 | L1-WS + L2-DOM | ✅ 合理 |
| TC-6-01~04 | L1-WS + L2-DOM | ✅ 合理 |

---

## 4. 依赖链 G1→G6 正确性

```
G1: 基础设施验证
 └→ G2: SlashMenu Agent 命令       ✅ G1 确认 extension 和 agent 就绪
   └→ G3: 手动触发 Subagent         ✅ G2 确认 agent 可在 SlashMenu 中选择
     └→ G4: SubagentRenderer 渲染   ✅ G3 触发执行后才需要验证渲染
       └→ G5: LLM 自动调用          ✅ G4 渲染正常后才验证自动调用（复用同一 renderer）
         └→ G6: 边界与错误           ✅ G5 正常流程通过后才测边界
```

**依赖链结论**：正确且合理。严格串行依赖，每层建立在前一层的基础上。

---

## 5. 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **MUST FIX** | 验证层可行性 | TC-3-01 | **"DevTools Network/Console 检查 WS payload"在 Electron dev mode 中可行性存疑**。Electron 的 `webContents` 默认打开 DevTools 后，Network tab 的 WS 面板可以查看 WebSocket frames（Electron Chromium 完整支持）。但问题在于：TC 描述期望在 WS 消息中看到 `subagent: { agent: "xxx", task: "yyy" }` 字段，然而当前 `useChat.ts` 的 `sendMessage()` 函数签名是 `sendMessage(content: string)`（L228），只传 content 字符串到 `{ type: 'message.send', payload: { sessionId, content } }`。**整个 T2 的数据链路改动（ChatInput emit subagent → PaneSessionView → useChat.sendMessage 扩展签名）还未实现**，TC-3-01 验证的是 T2 代码改动后的效果，但验证方法描述的是"看 WS 原始消息"，这是对的。真正的问题是：TC 没有说明如何在 DevTools 中**精确定位到这条特定消息**——当 LLM 流式响应产生大量 WS 消息时，手动找一条 `message.send` 很困难。 | 改进 TC-3-01 验证步骤：(1) 在发送前打开 DevTools → Network → WS → 选中活跃连接 → Messages tab；(2) 说明过滤关键字（如搜索 `message.send` 或 `subagent`）；(3) 或者改为在 sidecar 临时加 `console.log` 输出完整 payload（比 DevTools WS 抓包更可靠）。 |
| 2 | **MUST FIX** | 验证层可行性 | TC-3-02 | **sidecar 当前不 log 发送给 pi RPC 的 prompt 内容**。`session-pool.ts` L230 只 log `contentLength`，不 log prompt 本身。`server.ts` L368 的 `message.send` handler 也只 log sessionId + contentLength。TC-3-02 期望"sidecar 日志中可见发送给 pi RPC 的 prompt 包含 `<tool_call tool="subagent">` XML 标记"——但当前代码**不存在这样的日志输出**。这意味着 TC-3-02 的验证前提是：T3 编码时**必须**在 sidecar 中添加相关日志。 | (1) 在 TC-3-02 中明确标注前置条件："需要 T3 在 sidecar `message.send` handler 中添加 `console.log('[sidecar] subagent prompt:', agentPrompt)` 日志"；(2) 或在 Plan T3 验收标准中增加一条："sidecar 日志中输出构造的 XML 指令内容"。 |
| 3 | **MUST FIX** | 用例有效性 | TC-6-02 | **task 为空时的行为未在 spec/plan 中定义**。TC-6-02 期望"sidecar 仍构造 subagent 指令（task 为空字符串）"，但 spec 的约束中没有说 task 可以为空。plan T2 的 `handleSend` agent case 是 `const content = trimmed \|\| ''`，用户不输入 task 时 content 为空字符串，subagent 字段的 task 也是空字符串。问题是：pi subagent tool 收到空 task 后的行为是**未定义的**——可能正常执行（agent 自行决定做什么），也可能报错（task 是必填参数）。TC-6-02 写的是"pi subagent tool 接收空 task"，但没说期望结果是什么（成功？错误？）。 | (1) 明确 TC-6-02 的期望结果：pi 接收空 task 后的预期行为是什么？如果是"接受并执行"，那期望的验证结果是什么？如果是"报错"，那应该出现 SubagentRenderer error 状态。(2) 或者：在 spec 中增加约束——"task 不能为空，前端在 task 为空时禁用发送按钮"，这样 TC-6-02 就变成"发送按钮被禁用"的测试。 |
| 4 | **MUST FIX** | 数据流完整性 | TC-3-01 | **L1-WS 单层不足以验证完整数据流**。从 ChatInput 到 sidecar 的链路是：ChatInput emit → PaneSessionView handleSend → useChat.sendMessage → ws-client send → sidecar message.send handler。TC-3-01 只看 WS 消息（链路最后一跳），如果中间任何一环丢掉 `subagent` 字段（比如 PaneSessionView 的 handleSend 没有透传），WS 抓包看不出是哪一环的问题。 | TC-3-01 应分两步验证：(1) **L2-DOM/Console**：在 ChatInput handleSend 中临时 `console.log` 完整 emit payload，确认 subagent 字段存在；(2) **L1-WS**：确认 sidecar 收到的 message.send payload 包含 subagent 字段。或者在 T2 plan 的验收标准中增加"每个传递环节 log payload"的要求。 |
| 5 | **SHOULD FIX** | 用例完整性 | TC-4-04 | **"触发一个不存在的 agent 名称"的操作方式不明确**。当前 SlashMenu 只展示 pi 能发现的 enabled agent，用户无法通过 UI 选择不存在的 agent。TC-4-04 需要"手动构造"请求——但测试计划没说明如何构造。通过 DevTools Console 直接发 WS 消息？修改前端代码临时硬编码？ | 明确操作步骤：例如"在 DevTools Console 中执行 `window.__ws.send(JSON.stringify({type:'message.send', payload:{sessionId:'xxx', content:'test', subagent:{agent:'nonexistent', task:'test'}}}))`" 或"使用 curl 直接向 sidecar WS 发送消息"。 |
| 6 | **SHOULD FIX** | 缺失场景 | 全局 | **缺少并发 session 测试**。spec 明确要求 session 隔离（"所有消息必须带 sessionId"），但测试计划没有验证：两个 session 同时使用 subagent 时，结果是否正确路由到各自的聊天流。 | 增加 TC：创建两个 session → 各自手动触发不同 agent → 验证各 session 的 SubagentRenderer 显示各自正确的 agent name 和输出。可放在 G6 组。 |
| 7 | **SHOULD FIX** | 缺失场景 | 全局 | **缺少网络中断/WS 重连场景**。sidecar WS 断开后，前端重连时 subagent 正在执行的状态是否会丢失？虽然 spec 没有明确要求容错，但作为 E2E 测试计划应记录已知风险。 | 在 G6 增加 NOTE 级别的 TC："WS 断连时 subagent 执行中的状态恢复——当前未实现，记录为已知限制"。 |
| 8 | **SHOULD FIX** | 验证层 | TC-6-03 | **特殊字符转义验证方法依赖 sidecar 日志**，和 TC-3-02 同样的问题——当前 sidecar 不 log prompt 内容。TC-6-03 说"sidecar 日志中 XML 指令中特殊字符被正确转义"，但没有日志就看不到。 | 与 MUST FIX #2 一起解决：在 T3 编码时确保 sidecar log 构造的 XML 指令。TC-6-03 的验证依赖该日志。 |
| 9 | **NOTE** | 文档精度 | §1 前置检查 | 前置检查第 3 条 `cat src-electron/.xyz-agent/agents.json | python3 -c "..."` 使用了 `cat` 管道到 python。文件路径缺少项目根前缀。对于多 worktree 场景可能产生歧义。 | 改为 `cat "$(git rev-parse --show-toplevel)/src-electron/.xyz-agent/agents.json" ...` 或明确写完整路径。 |
| 10 | **NOTE** | 用例精确性 | TC-5-01 | 建议消息内容"请分析 src-electron/sidecar/src/server.ts 的代码质量"是否能触发 LLM 自动调用 subagent 取决于：(1) pi 的 system prompt 中是否有将代码分析任务路由到 subagent 的指令；(2) 可用的 agent 是否有代码分析能力。TC 没有说明前提条件。 | 增加前置说明："前提：pi 的 agent 配置中有支持代码分析的 agent（如 batch-code-tracer），且 pi 的 system prompt 会将代码分析类任务路由到 subagent。如果当前 agent 列表不包含合适的 agent，LLM 不会自动调用 subagent。" |

---

## 6. 具体验证项回应

### TC-3-01: DevTools Network/Console 可行性

Electron dev mode 下 DevTools 完全可用，Network tab → WS → Messages 可以查看 WebSocket frames。**技术上可行**，但有两个实际问题：

1. **定位困难**：LLM 响应过程中产生大量 WS 消息（text_delta、thinking_delta 等），手动在 Messages 列表中找到特定的 `message.send` 帧很困难。建议在发送前暂停，或使用 DevTools 的消息过滤功能。
2. **L1-WS 只验证最后一跳**：即使 WS 消息正确，也不能证明 ChatInput → PaneSessionView → useChat 的传递链路完整。如果 PaneSessionView 的 `handleSend` 丢掉了 `subagent` 字段但 `content` 正常，WS 消息看起来就是"正常文本消息"，TC 会误判为"发送成功但未触发 subagent"。

**建议**：TC-3-01 应补充 L2-DOM 级验证（Console log 中确认 emit payload 包含 subagent），或拆分为两个子步骤。

### TC-3-02: sidecar logging

当前代码确认**不包含**发送给 pi 的 prompt 内容日志：

- `server.ts` L368: `console.log('[sidecar] message.send: sessionId=..., contentLength=...')` — 只记长度
- `session-pool.ts` L230: `console.log('[session-pool] sendMessage: sessionId=..., contentLength=...')` — 同上
- `session-pool.ts` L233: `console.log('[session-pool] prompt acknowledged')` — 只记确认

TC-3-02 的验证前提是 T3 实现时**必须增加日志**。这应该在 Plan T3 的验收标准中明确体现，而非留给 E2E 测试计划去假设。

### TC-6-02: 空 task

**有效但定义不完整**。空 task 的操作路径是存在的：选择 agent → 输入框预填 `/agent:name ` → 直接按发送 → `trimmed` 是空字符串 → `subagent.task` 为空字符串。当前 `canSend` 计算为：

```ts
return (trimmed.length > 0 || activeCommand.value !== null) && !props.isStreaming
```

`activeCommand` 存在时 `canSend` 为 true，空 task 可以发送。**但期望结果未定义**——TC 只说"pi 接收空 task"，没说之后会怎样。

### 4 层适配

L1-WS 作为本项目 L1（API 层）的替代是合理的：WebSocket 是前端-sidecar 的唯一通信通道。但 L1-WS 对 T2（数据链路）的验证不够充分，原因是它只检查"sidecar 收到什么"，不检查"前端发出什么"。如果中间传递链路有问题，L1-WS 看到的是"没有 subagent 字段"，但不定位问题位置。

**建议**：对 T2（数据链路）相关的 TC 增加 Console log 辅助验证（介于 L1 和 L2 之间），确保每个传递环节的数据完整性。

---

## 7. 结论

**需修改后重审**

---

## Summary

E2E 测试计划评审完成，第 1 轮，4 条 MUST FIX，4 条 SHOULD FIX，2 条 NOTE，需修改后重审。

主要问题集中在：
1. **TC-3-01/TC-3-02 验证方法依赖未实现的前置条件**（sidecar 日志、DevTools WS 精确定位）
2. **TC-6-02 空 task 测试缺少期望结果定义**
3. **L1-WS 对数据链路测试不够充分**，需要补充中间环节验证

这些问题不阻塞测试计划的整体结构（依赖链正确、覆盖充分），但会导致 Phase 2 执行时具体 TC 无法验证或验证结果不可判定。
