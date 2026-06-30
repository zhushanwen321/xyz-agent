# 03 · 对话流（Chat Flow）测试流程

> 覆盖：消息发送全链路、流式消息（thinking/tool/text/error/fileChanges）、回合分组、session 隔离、auto_retry/queue、压缩
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

对话流是 xyz-agent 的核心高频路径。用户发送消息 → pi 流式回复（thinking → tool call → text）→ 渲染回合。涉及：

- **发送链路**：`chat.send` → `chatApi.send`（ack）+ `streamSubscribe`（长订阅收 chunk）
- **流式 chunk 处理**：`chatStore.appendAssistantChunk` → `applyChunk` 分发到 messages Map
- **回合分组**：`messageTurns.toRenderItems` 纯函数动态计算（user + assistants 成一组）
- **session 隔离**：所有状态按 sessionId 分区（messages/retry/queue/changeSetStatuses）

## 2. 组件树

```
Panel.vue (sessionId 存在, messageCount > 0)
  └─ MessageStream.vue（容器，无 testid）  ← 对话流主路径
       ├─ 空态欢迎语（messageCount===0 时）
       ├─ auto-scroll 锚点
       ├─ 「回到底部」浮层（无 testid）
       └─ Turn.vue × N（回合，无 testid）
            ├─ turn-meta 折叠条（工作中脉冲点 / 已工作 chevron + 思考×N 工具×N badge）
            ├─ user 气泡（右对齐，MarkdownRenderer）
            ├─ trace（折叠区，含 Block 列表）
            │    └─ Block.vue × N（无 testid）
            │         ├─ type='thinking'（紫斜体，默认收起可 toggle）
            │         └─ type='tool'（青色 mono，默认收起，running/failed 强制展开）
            ├─ 收尾 summary（末条 assistant content，streaming 时光标）
            ├─ ChangeSetCard.vue（变更集卡，无 testid）
            │    └─ 5 态 badge + A/M/D/U 文件行
            └─ ForkConfirmModal.vue（fork 确认弹窗）
       └─ SystemNotice.vue（system 提示行，独立穿插，无 testid）
```

## 3. data-testid 清单（关键缺口）

| testid | 文件:行 | 说明 |
|--------|---------|------|
| `composer-box` | Composer.vue:25 | composer 容器（唯一有 testid 的对话流相关元素） |

> ⚠️ **关键缺口**：`MessageStream.vue` / `Turn.vue` / `Block.vue` / `ChangeSetCard.vue` / `SystemNotice.vue` **均无 data-testid**。E2E 测试对话流**必须先补 testid**（或用文本/class 锚点，但脆弱）。
>
> **建议补的 testid**（落地 E2E 前需加）：
> - `MessageStream.vue` → `data-testid="message-stream-root"`
> - `Turn.vue` → `data-testid="turn-{index}"`（回合索引）
> - `Block.vue` → `data-testid="block-{type}-{toolCallId|thinkingId}"`（thinking/tool 块）
> - `ChangeSetCard.vue` → `data-testid="changeset-card-{messageId}"`
> - `SystemNotice.vue` → `data-testid="system-notice"`

**当前可用的文本锚点**（无需 testid，按 mock 固定文案断言）：

| 锚点类型 | 文本/特征 | 来源 |
|---------|----------|------|
| user 气泡 | 用户输入的原文 | `turn.user.content` |
| 收尾 summary | mock 固定前缀「已处理：」+「好的，我来处理这个请求。（mock 模拟回复）」 | `mock/run-send-stream.ts` |
| turn-meta 工作态 | 「工作中」+ 脉冲点 + elapsed 计时 | `Turn.vue working 态` |
| turn-meta 完成态 | 「已工作」+ chevron + 「思考 ×1」「工具 ×1」badge | `Turn.vue 完成态` |
| SystemNotice | `$ npm run build · exit 0` | mock bashExecution |
| ChangeSetCard | 「变更集」+「待审查」badge + 文件路径（src/mock-feature.ts） | mock fileChanges |

## 4. sendMessage 全链路时序

### 4.1 send 调用链（`useChat.ts`）

```
Composer.onSend(text)
  ├─ 守卫1: session.activeId 空 → return
  ├─ 守卫2: text.trim() 空 → return
  ├─ 守卫3: chat.isStreaming === true → return（不重复发）
  ├─ chat.appendUser(sid, trimmed)           ← 立即写 user 消息（status:complete）
  ├─ ensureStreamSubscription(sid, chat)     ← 幂等：首次订阅，二次 no-op
  │    └─ chatApi.streamSubscribe(sid, handler)
  │         handler 对每条 ServerMessage:
  │           chat.appendAssistantChunk(sid, msg)   ← 写 messages Map
  │           + 按类型翻转 isStreaming:
  │             message.message_start → setStreaming(true)
  │             message.complete / error / stream_error → setStreaming(false)
  └─ await chatApi.send(sid, trimmed)        ← ack（pi 已接收，非生成完成）
```

### 4.2 关键设计点（[HISTORICAL]）

- **订阅是会话级长订阅**（`streamSubscriptions = new Map<string, () => void>()`，模块级单例），**不是 per-send**
- 原因：`rpc-client.prompt()` 在 pi ack 即 resolve（非生成完成）。若 finally 里 unsub 会丢全部流式 chunk
- 流式状态由事件驱动（`message_start`→true，`complete`/`error`/`stream_error`→false），不依赖 `send()` resolve

### 4.3 每步输入输出

| 步骤 | 输入 | 输出 |
|------|------|------|
| `chat.appendUser(sid, text)` | `(sid, text)` | messages Map[sid] 追加 `{id:'u-{uuid}', role:'user', status:'complete'}` |
| `chatApi.streamSubscribe(sid, handler)` | `(sid, handler)` | 返回 unsub 函数；handler 接收 ServerMessage |
| `chatApi.send(sid, text)` | `(sid, text)` | `Promise<void>`（ack 即 resolve） |
| mock `chat.send` | `(sid, text)` | sleep(40ms) → resolve；同时 `void runSendStream(...)` fire-and-forget |

## 5. ServerMessage 类型表（流式 chunk）

定义在 [`shared/src/protocol.ts`](../../src-electron/shared/src/protocol.ts) line 207-347。`applyChunk`（[`chat-chunk-processor.ts`](../../src-electron/renderer/src/stores/chat-chunk-processor.ts)）消费的核心类型：

| type | payload 关键字段 | 前端处理 |
|------|----------------|---------|
| `message.message_start` | `{ sessionId, messageId }` | 新建 streaming assistant（status:'streaming', content=''）；清 queueState |
| `message.text_delta` | `{ sessionId, delta }` | content += delta（追加最后 assistant） |
| `message.thinking_start` | `{ sessionId, thinkingId }` | 追加 ThinkingBlock（content:'', collapsed:true） |
| `message.thinking_delta` | `{ sessionId, delta }` | 追加最后 ThinkingBlock.content |
| `message.thinking_end` | `{ sessionId }` | 设最后 ThinkingBlock.endTime |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | 追加 ToolCall（status:'running'） |
| `message.tool_call_end` | `{ sessionId, toolCallId, output, status, error }` | **按 toolCallId 锚定**更新（非最后 assistant） |
| `message.tool_call_update` | `{ sessionId, toolCallId, detail }` | 按 toolCallId 锚定更新 detail |
| `message.complete` | `{ sessionId, messageId, stopReason, usage }` | status → complete/error；收口残留 running toolCall；回填 usage |
| `message.error` | `{ sessionId, message }` | 最后 streaming assistant → status:'error' + 并入 errorText；否则新建 error 消息 |
| `message.stream_error` | `{ sessionId, content }` | 无前置流则合成 error；有则 content 追加 + status:'error' |
| `message.bashExecution` | `{ sessionId, command, exitCode, ... }` | 新建 system 消息 |
| `message.compactionSummary` | `{ sessionId, summary, ... }` | 新建 system 消息 |
| `message.file_changes` | `{ sessionId, messageId, fileChanges[], changeSetStatus, isFullSet }` | accumulating 增量合并 / ready 全集替换 |
| `message.auto_retry_start` | `{ sessionId, attempt, maxAttempts?, ... }` | 写 retryStates[sid] |
| `message.auto_retry_end` | `{ sessionId, success, attempt, ... }` | 清 retryStates[sid] |
| `message.queue_update` | `{ sessionId, steering?, followUp? }` | 写/清 queueStates[sid] |

**ToolCall.status 枚举**：`'running' | 'completed' | 'error' | 'end_not_received'`
**ChangeSetStatus 5 态**：`'accumulating' | 'ready' | 'partially-reviewed' | 'resolved' | 'superseded'`
**FileChangeStatus**：`'added' | 'modified' | 'deleted' | 'unmerged'`

## 6. chatStore API（session 隔离）

[`stores/chat.ts`](../../src-electron/renderer/src/stores/chat.ts)。核心是 `messages: Map<sessionId, Message[]>` 按 sessionId 分区。

| 方法 | 作用 |
|------|------|
| `getMessages(sid)` | 取分区消息（空返 []） |
| `appendUser(sid, text)` | 追加 user 消息 |
| `appendAssistantChunk(sid, msg)` | 委托 applyChunk 分发流式 chunk |
| `setStreaming(value)` | 设全局 isStreaming |
| `getRetryState(sid)` / `getQueueState(sid)` | per-session 重试/队列态 |
| `getChangeSetStatus(sid, msgId)` | 变更集卡状态（复合 key `${sid}:${msgId}`） |
| `isCompacting(sid)` / `setCompacting(sid, value)` | 压缩态（per-session） |
| `hydrate(sid, history)` | 注入历史（幂等，标记 hydrated） |
| `applyFileChanges(sid, msgId, changes, status, isFullSet)` | 变更集合并 |

**隔离机制**：所有读写带 sessionId；变更走不可变更新（新数组 + Map.set）保证 Vue 响应性。

## 7. mock 流式数据（`run-send-stream.ts`）

[`api/mock/run-send-stream.ts`](../../src-electron/renderer/src/api/mock/run-send-stream.ts) 模拟完整流式序列。`chat.send` 后 fire-and-forget，全程序检查 `isCancelled(sessionId)`：

```
message.message_start {sessionId, messageId}
  ↓ 60ms
[if /retry/i.test(text)]:
    message.auto_retry_start {attempt:1, maxAttempts:3, ...}
    sleep 800ms
    message.auto_retry_end {success:true, attempt:1}
  ↓
message.thinking_start {sessionId, thinkingId}
  for chunk in '让我分析一下这个请求……'（splitChunks，每 chunk 70ms）:
    message.thinking_delta {delta}
message.thinking_end {sessionId}
  ↓ 90ms
message.tool_call_start {toolCallId, toolName:'read', input:{path:'/mock/file.ts'}}
  sleep 90ms
message.tool_call_update {toolCallId, detail:'读取 42 行'}
  sleep 90ms
message.tool_call_end {toolCallId, output:'…文件内容…', status:'completed'}
  ↓ 90ms
extension:widget {widgetKey:'terminal', lines:['$ npm run build', ...]}
extension:status {statusKey:'build', text:'构建完成（mock）'}
  ↓
for chunk in '已处理："..."。\n好的，我来处理这个请求。（mock 模拟回复）'（每 chunk 70ms）:
  message.text_delta {messageId, delta}
  ↓ 120ms
message.file_changes {messageId, fileChanges:[{src/mock-feature.ts modified +10 -2}], changeSetStatus:'accumulating', isFullSet:false}
  sleep 120ms
message.file_changes {messageId, fileChanges:[3 个文件含 unmerged], changeSetStatus:'ready', isFullSet:true}
  ↓ 40ms
message.bashExecution {command:'npm run build', exitCode:0}
  ↓
message.complete {messageId, stopReason:'complete', usage:{inputTokens:1280, outputTokens:642, totalTokens:1922}}
```

**总耗时**：约 3-4 秒（thinking 8 chunk + tool 3×90ms + text 30 chunk + fileChanges 2×120ms）。

**TIMING 常量**（mock/index.ts）：`ack:40, startGap:60, chunk:70, done:40, switchCmd:30, thinkingGap:50, toolGap:90, fileChangesGap:120, retryGap:800`

**mock 不模拟的场景**：
- ❌ 失败工具流式（mock tool 恒 completed；失败工具只在历史 fixture s1 回合2 的 bash EBUSY）
- ❌ 错误流（mock 永远成功；错误路径只能单测注入 `message.error`）
- ❌ deleted fileChanges（只 modified/added/unmerged）
- ✅ retry（仅当输入含 'retry' 关键词触发）

## 8. MOCK 模式测试

### 8.1 集成测试（vitest，已有，覆盖最全）

| 测试文件 | 覆盖 |
|---------|------|
| [`__tests__/useChat.test.ts`](../../src-electron/renderer/src/__tests__/useChat.test.ts) | ensureStreamSubscription 幂等；send 三守卫；事件驱动 setStreaming；compact 状态机 |
| [`__tests__/chat-streaming-reset.test.ts`](../../src-electron/renderer/src/__tests__/chat-streaming-reset.test.ts) | **规则#3 复位**：error 路径重置 streaming/streamingMessage（否则 UI 卡死） |
| [`__tests__/fg5-message-stream.test.ts`](../../src-electron/renderer/src/__tests__/fg5-message-stream.test.ts)（18KB 最全） | applyChunk 全分支：thinking/tool/error/retry/queue/fileChanges；session 隔离；system 消息；历史 fixture |
| [`__tests__/panel/block-working.test.ts`](../../src-electron/renderer/src/__tests__/panel/block-working.test.ts) | Block working 态折叠（thinking/tool/end_not_received） |
| [`__tests__/panel/turn-working.test.ts`](../../src-electron/renderer/src/__tests__/panel/turn-working.test.ts) | Turn working 态（完成复位/elapsed 计时/非 working 静态） |
| [`__tests__/stores/toolcall-anchor.test.ts`](../../src-electron/renderer/src/__tests__/stores/toolcall-anchor.test.ts) | toolCallId 锚定（findToolCallOwner 乱序无害化） |

**运行**：
```bash
cd src-electron/renderer && npx vitest run src/__tests__/fg5-message-stream.test.ts src/__tests__/useChat.test.ts src/__tests__/chat-streaming-reset.test.ts
```

### 8.2 历史 fixture（`mock/data.ts` fixtureMessages）

5 个 session 演示 5 态（E2E 可激活验证渲染）：

| id | label | 状态 | 内容 |
|----|-------|------|------|
| `s1` | 重构 auth 模块 | error | 2 回合：回合1 thinking + 2 completed tool（read/edit）；回合2 error tool（bash EBUSY）+ status:'error'。**历史 fixture 无 fileChanges**（fileChanges 只在 run-send-stream 流式出现） |
| `s2` | Lint 排查中 | waiting | 末 assistant 含 running toolCall（bash） |
| `s3` | API 性能优化 | done | `[]` 空数组（验证欢迎语） |
| `s4` | Promise 代码评审 | running | 末 assistant status:'streaming'（纯文本流式中） |
| `s5` | 状态机重构（已废弃） | stopped | 末 assistant isInterrupted:true（abort） |

## 9. 非 MOCK 模式测试

```bash
cd src-electron && npm run dev
```

**手工冒烟清单**：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 激活真实 session，发消息 | user 气泡立即出现，pi 开始流式回复 |
| 2 | 观察 thinking 块 | 紫色斜体 thinking 出现，逐步追加，结束后可折叠 |
| 3 | 观察 tool call | pi 调真实工具（read/bash/edit），Block 显示工具名 + 输入 + 输出 |
| 4 | 观察文本流 | assistant 文本逐字追加，streaming 光标闪烁 |
| 5 | 观察 fileChanges | 变更集卡出现，列出真实改动文件（git status 对账） |
| 6 | 流式中输入追加消息 + ⏎ | steer 追加（turn-meta 出现 queue 指示） |
| 7 | 点 stop 按钮 | abort，pi 中断（DEFERRED），turn 显示 interrupted |
| 8 | 触发错误（断网/kill pi） | error 消息出现，isStreaming 复位（UI 不卡死） |

**关键验证点**（MOCK 测不出）：
- pi 真实流式 chunk 序列（字段是否与 protocol.ts 契约一致）
- tool_call_end 的 toolCallId 锚定（pi 可能乱序发 tool chunk）
- fileChanges 与真实 git status 对账
- error/stream_error 真实触发（WS 断连、pi 崩溃）
- abort 真实中断 pi

## 10. Playwright E2E 测试

### 10.1 前置：补 data-testid（必须）

对话流组件**当前无 data-testid**。E2E 前需给 `MessageStream.vue` / `Turn.vue` / `Block.vue` / `ChangeSetCard.vue` / `SystemNotice.vue` 补 testid（见 §3 建议）。补完后才能稳定 E2E。

### 10.2 测试场景（补 testid 后）

| 场景 | 锚点（补 testid 后） | 期望 |
|------|---------------------|------|
| E2E-CF-1：发消息 → user 气泡 | user 气泡文本 / `turn-0` | user 消息可见 |
| E2E-CF-2：流式 thinking | `block-thinking-{id}` | thinking 块可见 |
| E2E-CF-3：流式 tool call | `block-tool-{toolCallId}` | tool 块可见，含工具名 |
| E2E-CF-4：流式完成 → 收尾 summary | 收尾文本「好的，我来处理」 | summary 可见 |
| E2E-CF-5：fileChanges 变更集卡 | `changeset-card-{msgId}` | 卡片可见，含文件路径 |
| E2E-CF-6：retry（输入 retry） | retry 指示器 | 输入含 'retry' 触发重试指示 |
| E2E-CF-7：session 隔离 | 两个 session 消息独立 | 切 session 消息不串扰 |

### 10.3 完整 E2E 示例代码（补 testid 前的文本锚点版）

> 注意：以下代码用**文本锚点**（mock 固定文案），无需补 testid 但较脆弱。落地为 `e2e/chat-flow.spec.ts` 前建议先补 testid。

```typescript
import { test, expect } from './fixtures/launch-app'

test.describe('对话流 E2E', () => {
  test('E2E-CF-1: 发消息 → user 气泡 + mock 流式回复', async ({ page }) => {
    // 激活空 session（s3 API 性能优化，messageCount=0）
    await page.getByRole('button', { name: /^会话/ }).click()
    await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
    await page.getByText('API 性能优化').click()
    // 等 composer 出现
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // 输入并发送
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('测试对话流 e2e')
    await page.getByRole('textbox').press('Enter')
    // 发送成功的可靠信号：mock 流式完成后的收尾 summary（约 3-4 秒）。
    // 不直接断言 user 气泡 getByText('测试对话流 e2e') —— mock 回复会回显 user 输入
    //（run-send-stream.ts:49 '已处理："${text}"...'），该文本双匹配（user 气泡 + assistant
    // 回复），getByText 严格模式会报错。收尾 summary 是 mock 固定 CANNED_REPLY，单匹配稳定。
    await expect(page.getByText(/好的，我来处理这个请求/)).toBeVisible({ timeout: 15_000 })
  })

  test('E2E-CF-2: 流式 thinking + tool 可见（文本锚点）', async ({ page }) => {
    // ⚠️ thinking 可见性时序（Block.vue:85）：
    //   thinkingExpanded = computed(() => props.working || !thinkingCollapsed.value)
    //   - 流式中（working=true）→ 强制展开，全文可见
    //   - 流式完成（complete 后 working=false）→ 收起，全文 v-if 不在 DOM，只剩 header + preview
    //   mock 流式约 3-4 秒完成，故全文断言存在时序竞争（可能错过 working 窗口）。
    //   稳定策略：断言 thinking header（「思考」恒显）+ 收起态 preview（截断预览，收起后仍在 DOM）。
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('展示 thinking 和 tool')
    await page.getByRole('textbox').press('Enter')
    // thinking header 恒显（Block.vue:20「思考」文案，不受 working/collapsed 影响）
    await expect(page.getByText('思考', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    // tool 块 header 恒显（Block.vue:42-43「工具」+ toolName）。
    // mock toolCall toolName='read'（run-send-stream.ts:98），header 裸显 toolName 无括号。
    // 注意：完整「read(/mock/file.ts)」（toolName+argPath）在**展开态详情区**（Block.vue:47-48，
    // v-if="toolExpanded"），仅 working/running/failed 时渲染；流式完成后 working=false 收起，
    // 详情区卸载 → 时序竞争。故断言 header 恒显的 toolName「工具 read」而非展开态详情。
    // { exact: false } 因 header 是「工具...read」组合文案，用 contains 匹配 toolName 片段。
    await expect(page.getByText(/工具.*read/).first()).toBeVisible({ timeout: 15_000 })
  })

  test('E2E-CF-3: fileChanges 变更集卡可见', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('展示变更集')
    await page.getByRole('textbox').press('Enter')
    // mock fileChanges（accumulating → ready，约 120ms × 2 + 文本流式）
    // ChangeSetCard 文件行渲染完整 filePath（ChangeSetCard.vue:39 {{ c.filePath }}）
    // 用 .first() 防 accumulating/ready 两帧瞬时双匹配
    await expect(page.getByText(/src\/mock-feature\.ts/).first()).toBeVisible({ timeout: 15_000 })
    // 变更集状态 badge：ready → '待审查'（ChangeSetCard.vue:69）；'变更集' 恒显（line 18）
    await expect(page.getByText('待审查').first()).toBeVisible({ timeout: 5_000 })
  })

  test('E2E-CF-4: retry 关键词触发重试指示', async ({ page }) => {
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    await page.getByRole('textbox').click()
    // 输入含 'retry' 触发 mock auto_retry
    await page.getByRole('textbox').pressSequentially('请 retry 这个请求')
    await page.getByRole('textbox').press('Enter')
    // RetryIndicator 出现（Composer 上方，#13）
    // mock: auto_retry_start {attempt:1} → 800ms → auto_retry_end {success:true}
    await expect(page.getByText(/重试|retry/i)).toBeVisible({ timeout: 10_000 })
  })

  test('E2E-CF-5: 历史 session 渲染（s1 error 态）', async ({ page }) => {
    // s1 fixture 回合2 含 error tool（bash EBUSY）：output='EBUSY: 文件被外部进程占用，写入失败', status='error'
    // data.ts:164-165。error tool Block 默认强制展开（isFailed → toolExpanded=true，Block.vue:110-111）
    // 用 error tool 的 output 文本作锚点（稳定，不受 class 命名重构影响）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    // 等 MessageStream 渲染历史，error tool output 可见（Block.vue:51-57 result 区）
    await expect(page.getByText(/EBUSY|文件被外部进程占用/).first()).toBeVisible({ timeout: 10_000 })
  })

  test('E2E-CF-6: session 隔离（切 session 消息不串扰）', async ({ page }) => {
    // 激活 s1（2 回合）。s1 label「重构 auth 模块」，用 EBUSY error 文本作消息存在锚点
    // （'auth' 太宽泛，会匹配 README/auth 相关无关文本；EBUSY 是 s1 独有的 error tool output）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByText(/EBUSY/).first()).toBeVisible({ timeout: 10_000 })
    // 切到 s3（空，无 EBUSY）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('API 性能优化').click()
    // s3 空态：EBUSY 不应可见（隔离验证）
    await expect(page.getByText(/EBUSY/)).toHaveCount(0)
    // 切回 s1，消息仍在（EBUSY 重新可见）
    await page.getByRole('button', { name: /^会话/ }).click()
    await page.getByText('重构 auth 模块').click()
    await expect(page.getByText(/EBUSY/).first()).toBeVisible({ timeout: 5_000 })
  })
})
```

### 10.4 每步期望输入输出（E2E-CF-1 完整流式）

| 步骤 | 输入 | 输出 |
|------|------|------|
| 1. 激活 s3 | 点「API 性能优化」 | `switchSession('s3')`；composer 出现 |
| 2. 输入文本 | `pressSequentially('...')` | `draft = '...'`；发送 enable |
| 3. 按 ⏎ | `press('Enter')` | `onSend()` → `chat.send(sid, text)` |
| 4. appendUser | （内部） | `chat.appendUser('s3', text)` → user 消息入 messages Map['s3'] |
| 5. mock send | （内部） | sleep(40ms) → resolve；`runSendStream('s3', text)` fire-and-forget |
| 6. message_start | （mock 推） | `setStreaming(true)`；新建 streaming assistant |
| 7. user 气泡渲染 | （DOM） | user 气泡可见（立即，step 4 后） |
| 8. thinking 流 | （mock 推，60ms 后） | thinking 块出现，逐字追加（70ms/chunk） |
| 9. tool 流 | （mock 推，thinking 后） | tool Block 出现（start→update→end，90ms×3） |
| 10. text 流 | （mock 推） | 收尾 summary 逐字追加（70ms/chunk，约 30 chunk） |
| 11. fileChanges | （mock 推） | ChangeSetCard 出现（accumulating→ready，120ms×2） |
| 12. complete | （mock 推） | `setStreaming(false)`；turn 复位完成态；usage 回填 |
| 13. 终态断言 | （验证） | 收尾 summary「好的，我来处理这个请求」可见 |

## 11. 覆盖缺口（漏测 backlog）

当前 E2E（E2E-CF-1~6）覆盖发送 + 流式 + 历史 + retry + 隔离。以下场景待补：

| 缺口 | 场景 | 测试方式 | 优先级 |
|------|------|---------|--------|
| compact 压缩 | `/compact` 或自动触发 → compacting/compacted 态 | E2E（需补 testid，当前 composer 压缩态靠 title 锚点） | 高 |
| fork 会话 | 点 user 气泡编辑 → ForkConfirmModal → fork 新会话 | E2E（需补 Turn/ForkConfirmModal testid） | 中 |
| editAndResend | 编辑历史 user 消息 → 截断 + 重发 | 集成测试为主（useChat.editAndResend），E2E 需补 testid | 中 |
| 错误路径 | message.error / stream_error → UI 复位不卡死 | **集成测试必做**（chat-streaming-reset.test.ts 已覆盖），mock 不模拟错误 | 高 |
| tool 失败流式 | tool_call_end status='error' → 红框 + 强制展开 | 集成测试（block-working.test.ts U8），E2E 用 s1 历史 fixture（CF-5 已覆盖静态态） | 低 |
| thinking 完整文本 | 收起态点展开 → 完整 thinking 可见 | E2E（点击「思考」header toggle 后断言全文） | 低 |
| ChangeSetCard 审查交互 | 用户 Accept/Reject → partially-reviewed/resolved | E2E（需补 ChangeSetCard testid + 审查按钮锚点） | 中 |
| queue steer/followUp | 流式中 steer → queue_update → QueueBubble 指示 | E2E（需补 QueueBubble testid） | 低 |

## 12. 约束与盲区

| 约束 | 说明 |
|------|------|
| ❌ **data-testid 缺口** | MessageStream/Turn/Block/ChangeSetCard/SystemNotice 无 testid。E2E 前必须补，否则只能用脆弱的文本/class 锚点 |
| ⚠️ mock 流式耗时 | 一轮约 3-4 秒。E2E timeout 给 15s，用 `toBeVisible({timeout})` 等终态，禁止固定 sleep |
| ❌ mock 不模拟失败 | 错误路径（message.error/stream_error）无法 mock E2E 触发，只能单测验证（chat-streaming-reset.test.ts） |
| ❌ mock 不模拟 WS 断连 | WS 生命周期（断连/重连）只能非 MOCK 测 |
| ⚠️ turn-meta 文本锚点 | 「工作中」/「已工作」文本可能随 UI 调整变化，不如 testid 稳定 |
| ⚠️ ChangeSetCard 5 态 | mock 只演示 accumulating→ready，resolved/superseded/partially-reviewed 需手工触发（用户 Accept/Reject） |

## 13. 相关文档

- 组件源码：[`components/panel/MessageStream.vue`](../../src-electron/renderer/src/components/panel/MessageStream.vue) / [`message-stream/`](../../src-electron/renderer/src/components/panel/message-stream/)
- 流式处理：[`stores/chat-chunk-processor.ts`](../../src-electron/renderer/src/stores/chat-chunk-processor.ts)
- useChat：[`composables/features/useChat.ts`](../../src-electron/renderer/src/composables/features/useChat.ts)
- 集成测试：[`__tests__/fg5-message-stream.test.ts`](../../src-electron/renderer/src/__tests__/fg5-message-stream.test.ts)
- mock 流式：[`api/mock/run-send-stream.ts`](../../src-electron/renderer/src/api/mock/run-send-stream.ts)
- 发送入口：[02-composer.md](./02-composer.md)（Composer.onSend → chat.send）
- FileChanges 通道：[ADR-0024](../architecture/adr/0024-filechanges-channel.md)
