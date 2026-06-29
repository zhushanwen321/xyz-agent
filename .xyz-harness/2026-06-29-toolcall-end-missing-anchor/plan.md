# ToolCall end 锚定丢失修复 实现计划

## 业务目标

修复「对话流结束后，部分 toolCall 默认展开、显示进行中、无法收起」的 bug。根因是：event-adapter 并行处理 pi 事件时 tool_execution_end 与 toolResult 的 message_start 乱序，导致前端 `findLastAssistantIndex`（位置定位）命中错误的空 assistant message，end 更新静默失败，toolCall 永久卡在 `running`。

成功标准：
1. 流结束后所有 toolCall 的 status 不再停留在 `running`（无「进行中且无法收起」的卡死块）
2. 即使 event-adapter 并行乱序，toolCall 的 end/update 仍能精确命中正确的 toolCall（按 ID 锚定，不靠位置）
3. 真正 end 丢失的极端情况（进程崩溃/WS 断连/abort），残留 running toolCall 收口为 `end_not_received`，UI 渲染为灰色异常态而非假装成功
4. toolResult 的 message_start 不再被误译为空 assistant message（语义修正）

约束：
- 测试框架用 vitest（renderer + runtime 均已配置），禁止 node:test，禁止 tsx --test
- shared 枚举变更（ToolCallStatus 加 `end_not_received`）是公共协议变更，所有消费点必须全覆盖测试，不得漏处理
- 不串行化 event-adapter（保持并行），靠 ID 锚定让乱序无害化
- 不在 runtime 重抽象领域模型，仅修正 toolResult 语义
- 遵循项目 CLAUDE.md：禁 any（用 unknown）、emit 单 payload、错误重置 isGenerating

不做：
- 不重构 event-adapter 整体事件模型（只修 toolResult 语义 + 不引入串行化）
- 不改 pi 源码（fork 路径不在本次范围）
- 不改历史消息恢复路径（message-converter 已正确用 ID 锚定，仅需补 end_not_received 消费）

## 技术改动点

### shared 层（协议）
- 修改 `src-electron/shared/src/message.ts` — `ToolCallStatus` 枚举加 `'end_not_received'`（流结束仍未收到 end 的诚实态，区别于假装成功的 completed）

### runtime 层（事件语义修正）
- 修改 `src-electron/runtime/src/infra/pi/event-adapter.ts` — `handleMessageStart` 增加 `role === 'toolResult'` 分支：return null（不转发到前端，前端已通过 tool_execution_end 拿到 output）。复用已有 message-converter.ts:36-57 的语义认知（toolResult 是 assistant 的产物，非独立消息）。这是治本1：消除噪声 message 源，让 findLastAssistantIndex 不再被干扰
  - 注意：`message_end` 已在 NULL_EVENTS（event-adapter.ts:577）不转发，无需改

### renderer 层（ID 锚定 + 收口 + 渲染）
- 修改 `src-electron/renderer/src/stores/chat.ts` — 新增 `toolCallIndex: ref<Map<sessionId, Map<toolCallId, {msgIdx, tcIdx}>>` 索引状态。hydrate 时构建（遍历 message[].toolCalls 注册），session 卸载/切换时释放。暴露给 chat-chunk-processor 使用
- 修改 `src-electron/renderer/src/stores/chat-chunk-processor.ts` — 治本2（ID 锚定）：
  - `tool_call_start` case：建 toolCall 时同步注册索引 `index.set(callId, {msgIdx, tcIdx})`
  - `tool_call_end` / `tool_call_update` case：用索引 O(1) 定位 `{msgIdx, tcIdx}` 替代 `findLastAssistantIndex` + `map(c => c.id === callId)` 两级查找。索引未命中时降级为旧的线性查找（防御：历史消息无索引的场景）
  - `message.complete` case：新增收口逻辑——遍历最后一条 assistant message 的 toolCalls，把 `status === 'running'` 的按 stopReason 收口为 `end_not_received`（非 error stopReason）或 `error`（error stopReason），同步 endTime
  - message 不可变更新后，索引可能失效（数组重建），需在 applyChunk 的 ChunkContext 注入索引重建逻辑或改用 toolCallId 全局查找（见 Wave 2 决策点）
- 修改 `src-electron/renderer/src/components/panel/message-stream/Block.vue` — `end_not_received` 渲染：
  - 新增 `isUnfinished = computed(() => props.tool?.status === 'end_not_received')`
  - `toolExpanded`（:111）：`isUnfinished` 不强制展开（与 running 区分——running 实时可见，end_not_received 已结束可收起）
  - 模板（:42）：header 文案加 `isUnfinished ? ' · 未收到结果' : ''`
  - isFailed 红框逻辑：`end_not_received` 不走红框（非 error，是未知态），走灰色提示样式
- 修改 `src-electron/renderer/src/composables/logic/messageFormat.ts:22` — `end_not_received` 复制为 MD 时加 `（未收到结果）` 标注
- 修改 `src-electron/renderer/src/composables/logic/messageTurns.ts:119-123` — `hasFailedTool` 保持只判 `'error'`（end_not_received 非 error，不触发红框）。但需确认 Block 渲染是否依赖 hasFailedTool（如不依赖则此函数本次不改，仅评估）
- 修改 `src-electron/renderer/src/composables/features/useSidebar.ts:59` — `deriveStatus` 的 toolCall status 判断：`end_not_received` 不映射为 waiting（它已结束）。当前只判 `=== 'running'`，end_not_received 自然 fall through，无需改，但需补测试确认行为正确（不误判为 waiting）

### 测试文件
- 创建 `src-electron/runtime/test/event-adapter-toolresult.test.ts` — toolResult message_start 语义修正测试（当前零覆盖）
- 修改 `src-electron/renderer/src/__tests__/panel/block-working.test.ts` — 补 end_not_received 渲染用例
- 创建 `src-electron/renderer/src/__tests__/stores/toolcall-index.test.ts` — ID 锚定 + 收口逻辑单测
- 修改现有 chat-streaming-reset.test.ts / fg5-message-stream.test.ts — 适配索引变更

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W0 | message.ts | - | - | Prefactor：shared 枚举加 end_not_received（所有下游依赖此类型，必须最先） |
| W1 | event-adapter.ts, event-adapter-toolresult.test.ts | W0 | G1 | runtime 语义修正（独立于 renderer，可并行）|
| W2 | chat.ts, chat-chunk-processor.ts, toolcall-index.test.ts, chat-streaming-reset.test.ts, fg5-message-stream.test.ts | W0 | G1 | renderer ID 锚定 + 收口逻辑（与 W1 改动文件无交集 → 同组并行）|
| W3 | Block.vue, messageFormat.ts, messageTurns.ts, useSidebar.ts, block-working.test.ts | W2 | - | 4 个 status 消费点处理 end_not_received（依赖 W2 的 store 索引/收口逻辑就绪）|
| W4 | 验收 Wave | W1,W2,W3 | - | 全量单测 + 覆盖率 + 乱序竞态回归测试 |

**并行组判定依据**：W1（runtime/test）与 W2（renderer/stores）改动文件完全无交集、无调用依赖（runtime 改动经 shared 类型，W0 已提供）→ 可同组并行。W3 依赖 W2 的收口逻辑产出 `end_not_received` 值才能测渲染 → 串行。

**Wave 间根因传播预警**：W2（ID 锚定）与 W1（语义修正）共享同一类机制风险——「event-adapter 并行乱序」。W1 修 toolResult 噪声源，W2 修消费侧 ID 锚定，两者配合才能根治。若 W2 发现索引在消息不可变更新后失效（Map 重建导致 msgIdx 错位），需回看 W1 是否也受同类「数组重建」影响。

## 单测用例清单（AC 级）

### W1 runtime 测试（event-adapter-toolresult.test.ts）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | event-adapter.ts:handleMessageStart | 投递 `{type:'message_start', message:{role:'toolResult', toolCallId:'tc-1', content:[{type:'text',text:'ok'}]}}` | translate 返回 null，不产出 message.message_start | 正常 |
| U2 | event-adapter.ts:handleMessageStart | 投递 assistant turn `{type:'message_start', message:{role:'assistant',...}}` 或无 role 的 message_start | 仍正常产出 message.message_start（回归保护，不误杀）| 正常 |
| U3 | event-adapter.ts:handleMessageStart | 投递 bashExecution role（已知 role）| 仍产出 message.bashExecution（回归保护）| 边界 |
| U4 | event-adapter.ts:handleMessageStart | 连续投递 tool_execution_end → message_start(toolResult) → message_start(assistant turn) | toolResult 不产出，assistant turn 产出，tool_execution_end 正常产出 message.tool_call_end | 集成 |

### W2 renderer 测试（toolcall-index.test.ts + 适配测试）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U5 | chat-chunk-processor.ts:tool_call_end | 先 message_start 建 assistant#0，tool_call_start 建 tc-1(running)，再投递 toolResult message_start（建空 assistant#1），最后 tool_call_end(tc-1, completed) | tc-1 的 status 更新为 completed，落在 assistant#0（ID 锚定命中），不落在空 assistant#1 | 正常 |
| U6 | chat-chunk-processor.ts:tool_call_end | tool_call_start 建 tc-1(running)，**不投递** tool_call_end，直接投递 message.complete | tc-1 的 status 收口为 end_not_received（非 error stopReason）| 异常 |
| U7 | chat-chunk-processor.ts:tool_call_end | tool_call_start 建 tc-1(running)，message.complete 且 stopReason='error' | tc-1 收口为 error（error stopReason 走 error 分支）| 异常 |
| U8 | chat-chunk-processor.ts:tool_call_update | tool_call_start 建 tc-1，toolResult message_start 建空 assistant#1，tool_call_update(tc-1, detail) | detail 更新落在 assistant#0 的 tc-1（ID 锚定），非 assistant#1 | 正常 |
| U9 | chat-chunk-processor.ts:索引降级 | tool_call_end 的 toolCallId 未在索引中（历史消息无索引场景）| 降级为线性查找，仍能找到并更新（不静默失败）| 边界 |
| U10 | chat.ts:hydrate | hydrate 历史 messages（含多个 assistant 各带 toolCalls）| toolCallIndex 正确注册所有 toolCallId → {msgIdx, tcIdx} | 正常 |
| U11 | chat-chunk-processor.ts:乱序 | 并发投递 tool_call_end(tc-1) 与 message_start(toolResult)（模拟 event-adapter 并行，end 先 translate 但后 send）| 无论到达顺序，tc-1 的 end 都命中正确 toolCall（ID 锚定免疫乱序）| 边界 |

### W3 renderer 测试（block-working.test.ts 补充 + 适配）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U12 | Block.vue:end_not_received 渲染 | mount Block, props={type:'tool', tool:{status:'end_not_received', ...}, working:false} | header 含「未收到结果」文案；不走红框（border-danger 不存在）；不强制展开（点击可收起）| 正常 |
| U13 | Block.vue:end_not_received 收起态 | mount Block end_not_received, working=false，初始收起，点击 header | 可 toggle 展开/收起（不像 running 锁死）| 正常 |
| U14 | messageFormat.ts:22 | assistantToMarkdown(toolCall status=end_not_received) | 输出含「（未收到结果）」标注 | 正常 |
| U15 | useSidebar.ts:deriveStatus | 最后一条 toolCall status=end_not_received，isStreaming=false | session 状态不为 'waiting'（end_not_received 已结束，不当 waiting）| 边界 |

### W0 无独立单测（类型变更，编译期保证）

## E2E 用例清单

> 项目无 Playwright/Cypress。renderer 用 vitest + @vue/test-utils + happy-dom，runtime 用 vitest。E2E 降级为集成测试（mount 完整组件树验证 DOM）+ 手动验证。

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1 | 流结束 toolCall 卡死修复回归 | mock 流（VITE_MOCK=true）| mount MessageStream，模拟一次完整流（tool_call_start → tool_call_end → complete），流结束后断言 trace 收起、无「进行中」卡死块 | trace 收起为一行 meta，toolCall 状态非 running，块可收起 | vitest 集成测试（mount MessageStream，断言 DOM）|
| E2 | end 丢失收口回归 | mock 流，tool_call_start 后跳过 tool_call_end 直接 complete | 流结束后断言 toolCall 渲染「未收到结果」灰色态，块可收起不卡死 | 显示「未收到结果」，非「进行中」，可收起 | vitest 集成测试 |
| E3 | 多 toolCall 乱序回归 | mock 流，多个 toolCall 交错，模拟 end 乱序到达 | 每个 toolCall 的 end 都命中正确 toolCall，无串味 | 各 toolCall status 正确，无错位 | vitest 集成测试（applyChunk 投乱序事件序列）|
| E4 | 手动：真实 pi 对话流验证 | 连接真实 runtime | 发起含 TodoWrite/多工具调用的真实对话，观察流结束后 toolCall 状态 | 流结束后所有 toolCall 收起，无卡死展开的「进行中」块 | 手动（需真实 pi + runtime 环境）|

## 覆盖率 gate

- gate 命令（renderer）：`cd src-electron/renderer && npx vitest run --coverage`
- gate 命令（runtime）：`cd src-electron/runtime && npx vitest run --coverage`
- 增量范围：改动文件 `git diff --name-only main` 出列表，看报告中这些文件的行覆盖
  - renderer: chat.ts, chat-chunk-processor.ts, Block.vue, messageFormat.ts, messageTurns.ts, useSidebar.ts
  - runtime: event-adapter.ts
  - shared: message.ts（类型文件，不计行覆盖）
- 阈值：增量代码覆盖率 ≥ 60%（关键逻辑 chat-chunk-processor 收口/索引、event-adapter toolResult 语义追求更高覆盖）
- gate 位置：W4 验收 Wave 独立执行

## 实现步骤

1. [W0] 修改 `src-electron/shared/src/message.ts`：`ToolCallStatus` 加 `'end_not_received'`。运行 `cd src-electron && npx tsc --noEmit` 确认两端编译通过（新枚举值无生产者时消费点的 `=== 'running'` 等判断不会报错，但 TS 可能提示未处理分支——此时用占位 TODO 标记 W3 待处理）。提交。

2. [W1] 在 `event-adapter.ts` 的 `handleMessageStart` 增加 `role === 'toolResult'` 判断（return null）。创建 `event-adapter-toolresult.test.ts` 写 U1-U4 失败测试 → 实现 → `cd src-electron/runtime && npx vitest run test/event-adapter-toolresult.test.ts` 通过 → 提交。

3. [W2] 在 `chat.ts` 加 `toolCallIndex` 状态 + hydrate 构建逻辑。修改 `chat-chunk-processor.ts`：tool_call_start 注册索引，tool_call_end/update 用索引锚定（降级线性查找），message.complete 加收口逻辑。注意：messages 不可变更新会重建数组，索引的 msgIdx 可能失效——**决策点：applyChunk 内更新后立即重建该 session 的索引（O(n) 遍历 toolCalls），或改用 toolCallId 全局线性查找替代索引（简化但每次 O(n)）**。创建 `toolcall-index.test.ts` 写 U5-U11 → 实现 → 通过 → 提交。与 W1 可并行。

4. [W3] 修改 `Block.vue`（end_not_received 渲染：未收到结果文案 + 不红框 + 不锁展开）、`messageFormat.ts`（MD 标注）、评估 `messageTurns.ts`/`useSidebar.ts` 是否需改（补充测试确认）。补 `block-working.test.ts` U12-U15 → 通过 → 提交。

5. [W4 验收] `cd src-electron/renderer && npx vitest run`（全量 renderer）+ `cd src-electron/runtime && npx vitest run`（全量 runtime）+ 覆盖率 gate。E1-E3 集成测试全绿。全绿才算完成。E4 手动验证由用户在真实环境执行。
