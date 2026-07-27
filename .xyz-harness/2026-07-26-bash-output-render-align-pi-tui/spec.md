---
verdict: pending
---

# Bash 执行对齐 pi-tui（feat-composer-bash-execute W4）

## Background

xyz-agent 在 `feat-composer-bash-execute` 分支 W1–W3 已实现 composer `!`/`!!` bash 命令分流（用户在前端 composer 输入 `!cmd` 直接执行 shell，不经 LLM agent turn，输出作为 system message 渲染）。

**用户目标**：对齐 pi-tui 的 `!`/`!!` 命令执行逻辑，展示到 GUI 上。

### 原方向被推翻（A.3 渲染修复方案废弃）

本 spec 初稿（方案 A.3）只解决渲染层问题（BashOutputBlock 高度重叠 + 视觉不一致），把 pi-tui 执行逻辑对齐（方案 E）作为"W5+ 独立规划"排除。经与用户确认，**用户的目标是"执行逻辑对齐"，不是"渲染 bug 修复"**——A.3 方向错位，废弃。

本 spec 重写为方案 E：让 xyz-agent 的 bash 执行行为全面对齐 pi-tui。

### 现状事实

#### pi-tui 的 `!`/`!!` 执行逻辑（权威基线）

源码：`pi-mono/packages/coding-agent/src/`（本地路径 `~/GitApp/pi-ecosystem/pi-mono/`）

**1. 入口分流**（`interactive-mode.ts:2769-2785`）
```ts
if (text.startsWith("!")) {
    const isExcluded = text.startsWith("!!");
    const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
    if (command) {
        if (this.session.isBashRunning) {
            this.showWarning("A bash command is already running. Press Esc to cancel it first.");
            return;
        }
        await this.handleBashCommand(command, isExcluded);
        return;  // 不进入 session.prompt()，不走 LLM turn
    }
}
```
- `!` 进 LLM context，`!!` 不进（仅 `excludeFromContext` 标志差异）
- bash↔bash 互斥（`isBashRunning` guard，第二个 bash 被拒）

**2. bash↔streaming 并发**（核心行为）
pi-tui **允许**在 AI streaming 时执行 bash。bash 视觉挂载策略（`interactive-mode.ts:5947-5959`）：
```ts
const isDeferred = this.session.isStreaming;
this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
if (isDeferred) {
    this.pendingMessagesContainer.addChild(this.bashComponent);  // streaming 时挂 pending 区
    this.pendingBashComponents.push(this.bashComponent);
} else {
    this.chatContainer.addChild(this.bashComponent);  // idle 时直接进 chat
}
```
- `pendingMessagesContainer` 与 `chatContainer` 是同级兄弟 `Container`，bash 在 pending 区独立显示（在 streaming assistant 消息下方，不插队到中间）
- 用户下一条普通消息提交时 `flushPendingBashComponents()`（`interactive-mode.ts:4086-4092` + `2812`）把 bash 从 pending 搬到 chat

**3. JSONL 写入顺序**（pi 内部保证，对 RPC 透明生效）
`AgentSession.recordBashResult`（`agent-session.ts:2709-2733`）：
```ts
recordBashResult(command, result, options?): void {
    const bashMessage: BashExecutionMessage = { /* ... */ };
    if (this.isStreaming) {              // streaming 时
        this._pendingBashMessages.push(bashMessage);   // 只进内存队列，不写 JSONL
    } else {                             // idle 时
        this.agent.state.messages.push(bashMessage);
        this.sessionManager.appendMessage(bashMessage);  // 立即写 JSONL
    }
}
```
- `_runAgentPrompt` finally（`agent-session.ts:1032`）调 `_flushPendingBashMessages()`：agent turn 结束时统一把 pending bash 消息追加到 messages + 写 JSONL
- **保证 tool_use/tool_result 配对不被 bash 消息打断**

**4. 关键事实：pi bash RPC 路径完全汇合于同一 pending 机制**
`rpc-mode.ts:553-558`：
```ts
case "bash": {
    const result = await session.executeBash(command.command, undefined, {
        excludeFromContext: command.excludeFromContext,
    });
    return success(id, "bash", result);
}
```
- TUI 路径（`interactive-mode.ts:5962`）与 RPC 路径（`rpc-mode.ts:554`）**都调用 `session.executeBash`**（`agent-session.ts:2675`）→ 同一个 `recordBashResult`
- **xyz-agent 调 pi bash RPC 时，pi 的 `_pendingBashMessages` 延迟 flush 自动生效**，无需 xyz-agent 在 runtime 层重新实现 pending

#### xyz-agent 当前实现（W1-W3 现状）

**1. 入口分流**（已对齐 pi-tui）
- `packages/renderer/src/composables/panel/useComposerBash.ts:68-75` `extractBashCommand` / `trySendBash`：`!`/`!!` 前缀检测 + `excludeFromContext` 标志
- `Composer.vue:353-383` onSend 分流顺序：fork → handoff → landing bash → bash → /compact → send
- 不进 LLM agent turn，直接走 `chat.sendBash` → WS `message.bash` → runtime `dispatcher.sendBash`

**2. 互斥约束**（**核心差异**：强互斥 vs pi-tui 允许并发）
`packages/runtime/src/services/session/message-dispatcher.ts:229-241`：
```ts
if (activeSession.isGenerating || activeSession.isCompacting || activeSession.isBashRunning) {
    this.broker.broadcast({ type: 'send.rejected', payload: { sessionId, reason: 'busy', message: 'Agent 正在处理' } })
    return { blocked: true, rejected: true }
}
```
- `sendBash` 预检：`isGenerating || isCompacting || isBashRunning` 任一为 true 即拒绝
- `sendMessage` 预检（`message-dispatcher.ts:97`）：同样三者检查
- **AI streaming 时（isGenerating=true）用户输 `!cmd` 会被 busy reject**——与 pi-tui 行为不一致

**3. bash 视觉**（W3 实现，**无 pending 机制**）
`packages/renderer/src/stores/chat-bash-effects.ts:28-45` `bashStartEffect`：收到 `message.bashStart` 立即 append 一条 `role:'system' + status:'streaming' + bashExecution` 消息到 chat 流末尾。
- 因强互斥，bash 执行时不会有 streaming assistant 消息共存，不存在"插队"问题
- 渲染走 `MessageStream.vue:57-62` 的 `<BashOutputBlock>` 分支

**4. JSONL 写入**（完全依赖 pi，已对齐）
xyz-agent runtime **不自己写 bash JSONL**（grep `_pendingBash|writeBash` 在 runtime/src 零命中）。bash 结果落盘 100% 由 pi 负责，pi 的 `_pendingBashMessages` 对 RPC 透明生效（见上）。

**5. 渲染重叠 bug**（W3 遗留，本 spec 会顺带修复）
- `BashOutputBlock.vue` 未注册 `useResizeReport`，virtual list 永远用 `ESTIMATED_TURN_HEIGHT=200`（`MessageStream.vue:248`）估算高度
- 长输出 bash（真实 280-300px）→ 后续 item offset 按"少算 N px"计算 → 视觉重叠

**6a. W3 遗留 bug**：bash 超时 timer 未清理（FR-6 修复）
- `bashStartEffect`（`chat-bash-effects.ts:44`）调 `armBashTimer(sid)` 挂 300s timer
- `bashResultEffect`（`chat-bash-effects.ts:53-74`）和 `markBashError`（`:89-101`）**都没调 `clearBashTimer`**
- `MessageEffectContext` 接口（`chat-message-effects.ts:100-126`）只暴露 `armBashTimer`，没暴露 `clearBashTimer`
- 后果：bash 完成后 300s timer 仍在跑，到期触发 `finalizeSession('timeout')`（虽幂等 no-op，但 dev warn 噪音 + 潜在竞态）

**6b. W3 设计缺陷**：bash timer 跨域收口（CRITICAL，L1 放宽并发后变为致命回归）
- `chat-timers.ts:50-56` 的 `armBashTimer` 回调调 `finalizeSession(sessionId, 'timeout')`
- `finalizeSession`（`chat.ts:663-669`）→ `finalizeMessagesImpl` 收口该 session **所有 status==='streaming' 的实体**（不区分 assistant streaming 还是 bash streaming）
- **强互斥时**：bash timer 跑时 streaming 不存在（互斥保证），误杀对象不存在，问题隐性
- **L1 放宽后**：共存期间（AI streaming + bash 同时跑），bash timer 300s 到期 → `finalizeSession('timeout')` → 把**还在正常产出内容的 assistant turn 一起收口成 error/timeout 态**
- 这是 L1 放宽并发直接引入的回归，必须与 L1 同期修复（L7）

**6c. W3 设计缺陷**：abort 入口分散，无共存路由（CRITICAL，L1 放宽并发后行为不一致）
- pi-tui Esc 优先级（`interactive-mode.ts:2544-2552`）：`isStreaming > isBashRunning`，共存时 Esc 只 abort streaming
- xyz-agent 当前两个停止入口独立：stop 按钮调 `useChat().abort`（`useChat.ts:322`，abort agent turn）；BashOutputBlock 取消按钮调 `abortBash`（`useChat.ts:367`）
- **L1 放宽后**：共存时无统一停止入口，用户无法一键停 streaming，与 pi-tui 语义不符（L8 修复）

### RPC 协议限制（本 spec 无法解决，需明确记录）

**pi bash RPC 不提供 streaming output events**：
- `rpc-mode.ts:554` 传 `onChunk = undefined`
- pi 的 `AgentSessionEvent` 没有 `bashStart` / `bashOutput` / `bashResult` event type
- bash output 只能等进程结束后从 RPC 返回值 `BashResult.output` 一次性拿到

后果：
- pi-tui 的 `BashExecutionComponent` 用 `onChunk` 实时追加 output（真实流式）
- **xyz-agent 的 bash output 永远是"等待 → 一次性结果"**（假 streaming，streaming 态只显示 spinner + 取消按钮，无实时 output）
- 这是 pi RPC 协议层面的限制，本 spec 无法解决。若未来需要真实 streaming，需 runtime 层自己 spawn bash（不走 pi RPC），但那违背"依赖 pi"的架构约定，超出本 spec 范围

## Functional Requirements

### FR-1: bash↔streaming 并发对齐 pi-tui

AI streaming 时（`isGenerating=true`），用户在 composer 输入 `!cmd` / `!!cmd` 应**允许执行**，不被 busy reject。bash 与 streaming assistant 并发运行。

- bash↔bash 互斥保留（与 pi-tui 一致，`isBashRunning` guard）
- bash↔compacting 互斥保留（compacting 是会话级重整，不应被打断）
- **sendMessage 预检本期不动**（保留 `isBashRunning` 拒绝）。原因：pi 的 `prompt()` 在 `isStreaming` 时强制要求 `streamingBehavior` 参数（`agent-session.ts:1119-1126`），否则直接 throw。xyz-agent 的 `client.prompt`（`message-dispatcher.ts:123`）没传该参数。sendMessage 预检因 `isGenerating` 拒绝，永远到不了 pi throw 的地方——本期保持这个安全网。未来若放宽 sendMessage，必须同步改 rpc-client 传 `streamingBehavior`（见 Open Questions OQ-1）。

### FR-2: 共存场景下视觉正确

streaming assistant turn + streaming/complete bash 消息共存时：
- bash 消息在虚拟列表中位于 streaming assistant turn **下方**（messages 数组顺序天然保证）
- streaming assistant turn 的高度变化（RO 上报）与 bash 消息的高度变化互不干扰
- 不出现视觉重叠（bash 真实高度被 virtual list 正确感知）

### FR-3: agent turn 结束后 bash 视觉归位

agent turn 结束（`isSessionActive` true→false）时，若存在共存期间的 bash 消息：
- bash 消息已在正确位置（虚拟列表按 messages 顺序渲染，无需 pi 风格的 pending→chat 搬运）
- 确保滚动跟随正确（bash 完成后若用户在底部，视图跟随到 bash 底部）

**注**：pi-tui 需要 `flushPendingBashComponents` 是因为它的 `Container` 顺序追加机制。xyz-agent 虚拟列表按 messages 数组顺序渲染，bash append 末尾即天然在 streaming turn 下方，**不需要 pi 风格的 pending 容器**。这是架构差异带来的简化。

### FR-4: 渲染重叠修复（顺带解决 W3 遗留）

BashOutputBlock 在 chat 流中占用的真实高度由 DOM 实际尺寸决定，virtual list layout 拿到真实高度，不再用 200px 估算。

### FR-5: 视觉对齐 trace block（极简风）

BashOutputBlock 视觉风格对齐 `Block.vue` 的 thinking/tool/text block：去掉卡片边框/浅底，统一 `py-2` 间距。语义区分保留（mono 字体 + `$ ` 前缀 + exit code 标签）。

### FR-6: W3 遗留 timer bug 修复

`bashResultEffect` / `markBashError` 完成时调 `clearBashTimer`，`MessageEffectContext` 暴露 `clearBashTimer`。

### FR-7: 行为与数据契约不变（硬约束）

- `bashStartEffect` / `bashResultEffect` 创建的 system message 形态不变（`role:'system' + bashExecution`）
- converter（`message-converter.ts:298-325`）对 `role:'bashExecution'` JSONL entry 的还原不变
- 重开 session 时 bash 历史经两条路径（RPC `get_messages` + JSONL 文件读取）正确还原
- 取消按钮行为不变（仍调 `useChat().abortBash(sessionId)`）
- pi 的 `_pendingBashMessages` 机制对 xyz-agent 透明，xyz-agent 不介入 JSONL 写入顺序

### FR-8: bash timer 不跨域收口（修 C2）

bash 超时 timer（`armBashTimer`，300s）到期时，**只收口 bash 消息**（把 `status==='streaming' + bashExecution` 的那条推到 error 态），**不调 `finalizeSession`**，不影响共存中的 assistant turn。

共存期间（streaming + bash）bash timer 到期 → bash 消息变 error 态，streaming assistant turn 继续正常运行。streaming timer 与 bash timer 完全解耦，各管各的域。

### FR-9: abort 优先级对齐 pi-tui（修 C1）

共存场景下（streaming + bash 同时进行），用户点 stop 按钮的行为对齐 pi-tui（`interactive-mode.ts:2544-2552`）：**先 abort streaming，不 abort bash**。

- stop 按钮调 `useChat().abort`（abort agent turn），与现有行为一致
- BashOutputBlock 取消按钮独立保留，调 `abortBash`（专门取消 bash，不影响 streaming）
- **共存时 stop 按钮不联动 abortBash**（与 pi-tui 一致：Esc 优先级 streaming > bash）

不做"一键停全部"（与 pi-tui 语义不符，且 GUI 下两个独立入口更清晰）。

## Non-Functional Requirements

### NFR-1: 性能

引入 BashOutputBlock 高度上报后，不破坏 virtual list 已有性能特性：
- 同帧多 RO 回调合并（`useVirtualTurnList.ts:276-307` `flushHeightReports`）
- ε 阈值过滤（`useResizeReport.ts:99` `< 1px` 忽略）
- 视口锚定补偿（`useVirtualTurnList.ts:285-307` `scrollAdjustDelta`）

共存场景（streaming + bash）下，两个 RO 上报源（Turn.vue + BashOutputBlock）不应互相干扰。

### NFR-2: 测试

必须新增/更新测试覆盖（AGENTS.md 测试规范 §5-§8，三视角：构建者 + 使用者 + 观察者）：
- **并发场景**：mock `isGenerating=true` 时 `sendBash` 不被 reject（dispatcher 单测）
- **共存渲染**：mount MessageStream，构造 streaming assistant turn + bash 消息共存，断言顺序 + 无重叠
- **BashOutputBlock RO 注册**：mock RO，验证 reportHeight 被调用
- **BashOutputBlock 视觉对齐**：DOM 断言（无 border、无 bg-surface-hover/40、统一 `py-2`）
- **重开恢复**：bash 历史经 converter 还原不变（回归保护）
- **timer 清理**：bashResultEffect / markBashError 调 clearBashTimer（单测）

### NFR-3: 重开恢复（AGENTS.md 规则 7.5）

回归保护：
- `message-converter-bash.test.ts`：bashExecution → system message 还原不变
- `MessageStream-bash.test.ts`：路由到 BashOutputBlock 不变
- hydrate session 时（`chat-message-effects.ts:556-557` 的 bashStart/Result 注册）行为不变

## Solution Direction

**核心策略**：分层改造，L1 是核心（对齐 pi-tui 执行逻辑），L2-L6 是 L1 的必要配套 + 遗留修复。

### L1: runtime 放宽互斥（核心）

**文件**：`packages/runtime/src/services/session/message-dispatcher.ts`

`sendBash` 预检（line 232）移除 `isGenerating`：
```ts
// 改前
if (activeSession.isGenerating || activeSession.isCompacting || activeSession.isBashRunning) {
// 改后
if (activeSession.isCompacting || activeSession.isBashRunning) {
```

`sendMessage` 预检（line 97）是否移除 `isBashRunning` 待 Open Questions 确认（bash 执行时是否允许发新消息排队）。

**风险**：
- pi 的 `executeBash` 不阻塞（直接 spawn bash 进程），与 streaming 并行——pi 已支持
- pi 的 `recordBashResult` 在 streaming 时走 `_pendingBashMessages`——pi 已保证 JSONL 顺序
- xyz-agent runtime 层的 `isBashRunning` 仍正常置位/复位（sendBash finally），不影响 abortBash 链路

### L2: 共存场景的虚拟列表钉扎（配套 L1）

**问题**：L1 后会出现 streaming assistant turn + bash 消息共存。虚拟列表的"末项钉扎"机制（`useVirtualTurnList.ts:230-238` SR3/INVAR-10）原本保证 streaming assistant turn（末项）恒在窗口内。bash 消息 append 末尾后，**bash 成为末项，streaming assistant turn 变成倒数第二项**，用户向上滚动时可能被卸载 → RO 断开 → 高度不再更新 → 布局错乱。

**⚠️ 关键修正（reviewer 发现）**：钉扎应作用在 **`startIndex`** 上，不是 `endIndex`。用户向上滚动时抬升的是 `startIndex`（视口顶部 item index 上移），streaming turn 滚出视口顶部时是 `startIndex > streamingTurnIdx`。此时 `endIndex`（被末项 bash 钉在 n-1）根本不会 `< streamingTurnIdx`，原伪代码条件不触发。参考已有的 editing 钉扎 SR5（`useVirtualTurnList.ts:240-245` 的 `startIndex = min(startIndex, editingPinIndex)` 模式）。

**方案**：扩展钉扎机制，新增 streaming turn 钉扎（与 editing 钉扎同款，作用于 startIndex）。

**文件**：`packages/renderer/src/composables/effects/useVirtualTurnList.ts`

新增 `streamingPinIndex` ref + `pinStreaming(idx)` 函数（与 `editingPinIndex` / `pinEditing` 对称）：
```ts
const streamingPinIndex = ref(-1)
function pinStreaming(idx: number): void {
  streamingPinIndex.value = idx
}
```

startIndex 钉扎逻辑（在 editing 钉扎分支附近，line 240-245 区域扩展）：
```ts
// editing 钉扎（已有，SR5）
if (editingPinIndex.value >= 0 && startIndex > editingPinIndex.value) {
  startIndex = editingPinIndex.value
  if (endIndex < startIndex) endIndex = startIndex
}
// streaming 钉扎（新增）：共存期间 streaming turn 不能滚出视口（RO 会断）
if (streamingPinIndex.value >= 0 && startIndex > streamingPinIndex.value) {
  startIndex = streamingPinIndex.value
  if (endIndex < startIndex) endIndex = startIndex
}
```

**谁调 pinStreaming**：`MessageStream.vue` watch 最后一个 turn 的 `isStreaming` 标志，true 时调 `pinStreaming(lastTurnIdx)`，false 时调 `pinStreaming(-1)`。turn.isStreaming 信息已在 `messageTurns.ts:121-128` 计算。

**风险**：
- 钉扎 startIndex 会进一步削弱底部虚拟化（SR3 已知限制的延伸）。共存期间 startIndex 被钉在 streaming turn 处，其下所有 item（streaming turn 到末项 bash）恒渲染。长对话（1000+ turns）+ 用户滚到中部 + 共存，会渲染 startIndex→lastIndex 几乎全量。但共存是临时态，性能影响可接受（需加回归测试，见 L6）。
- 两个 RO 上报源（Turn.vue + BashOutputBlock）共存：`flushHeightReports`（`useVirtualTurnList.ts:276-307`）按 key 独立判定 delta，两者并存不会互相算错。但共存期间若用户上滑（非贴底），两个 delta（streaming turn 高度增长 + bash 高度变化）都累加进同一 `scrollAdjustDelta`，需验证不会过补偿（见 Open Questions）。

### L3: BashOutputBlock 高度上报（配套 L1 + 修复 W3 渲染 bug）

**文件**：`packages/renderer/src/components/panel/message-stream/BashOutputBlock.vue`

加 `rootEl` ref + `useResizeReport`：
```vue
<div ref="rootEl" class="bash-output-block ...">
  ...
</div>

<script setup>
import { useResizeReport } from '@/composables/effects/useResizeReport'
const rootEl = ref<HTMLElement>()
// ⚠️ key 必须与 useVirtualTurnList 的 itemKey 一致（system 项用 s- 前缀）
useResizeReport(rootEl, () => `s-${props.message.id}`)
</script>
```

**⚠️ 实现陷阱（reviewer 发现）**：`useVirtualTurnList.ts:57-63` 的 `itemKey` 对 system 项用 `s-${message.id}` 作键：
```ts
function itemKey(item: RenderItem, idx: number): string | null {
  if (item.kind === 'turn') return ... // turn 用首消息 id
  return item.message.id ? `s-${item.message.id}` : `s-idx-${idx}`  // system 用 s- 前缀
}
```
BashOutputBlock 是 system 消息渲染，**keyGetter 必须返回 `s-${props.message.id}`**（带 `s-` 前缀），否则 RO 上报的高度写不进 heights Map（key 不匹配），仍走 200px 估算，FR-4 永远不满足。这是 L3 成败关键。

`useResizeReport` 已有 ε 阈值过滤（防 RO 死循环）+ 批量上报合并，复用成熟基建。

**外层 absolute 容器**（`MessageStream.vue:60-62`）的 ref 处理：system message 的 absolute 容器包裹 BashOutputBlock，**外层容器不注册 RO**（无 ref）。BashOutputBlock 自身上报，外层容器高度由 BashOutputBlock 撑开。`provideTurnResizeRegistry` 只调用一次，Turn 和 BashOutputBlock 共用同一 registry，key 不同（turn 用首消息 id，bash 用 `s-${message.id}`），不冲突。

### L4: BashOutputBlock 视觉对齐 trace block（可选，视觉一致）

**文件**：`packages/renderer/src/components/panel/message-stream/BashOutputBlock.vue`

去掉卡片样式，改用极简风（参考 `Block.vue:13` `<div class="trace-blk py-2">`）：
- 去掉 `rounded-md border border-border bg-surface-hover/40 px-3`
- 统一 `py-2` 间距
- 保留 mono 字体（command + output）
- `$ ` 前缀（可选，见 Open Questions）
- exit code 标签位置/颜色重新设计（参考 Block.vue 的 Check/XCircle 图标）

### L5: 修复 W3 clearBashTimer 未调用 bug

**文件**：
- `packages/renderer/src/stores/chat-message-effects.ts`：`MessageEffectContext` 接口（line 100-126）新增 `clearBashTimer: (sessionId: string) => void` 字段
- `packages/renderer/src/stores/chat.ts`：`applyMessageEvent` 注入 ctx（line 634-651）新增一行 `clearBashTimer,`（`clearBashTimer` 已在 `chat.ts:742` 解构自 `initTimers`，只是没注入 ctx）
- `packages/renderer/src/stores/chat-bash-effects.ts`：`bashResultEffect`（line 53-74）和 `markBashError`（line 89-101）结尾调 `ctx.clearBashTimer(sid)`

**无循环依赖风险**：`clearBashTimer` 与 `armBashTimer` 同在 `chat-timers.ts`（同一 `initTimers` 返回），`armBashTimer` 已在 ctx 里，加 `clearBashTimer` 不引入新依赖路径。

### L6: 测试 + 回归

**新增/更新测试**（路径已修正——dispatcher 测试在 runtime 包）：

| 测试文件 | 覆盖 |
|---|---|
| `packages/runtime/test/message-dispatcher-precheck.test.ts`（扩展） | L1：mock `isGenerating=true` 时 `sendBash` 不被 reject；`isCompacting`/`isBashRunning` 仍拒 |
| `packages/runtime/src/__tests__/message-dispatcher-bash.test.ts`（扩展） | L1 回归：abortBash 链路不受影响 |
| `packages/renderer/src/__tests__/components/BashOutputBlock.test.ts` | L3：RO 注册（mock ResizeObserver，断言 `reportHeight` 被调用，key 是 `s-${id}`）+ L4 视觉对齐 DOM 断言 |
| `packages/renderer/src/__tests__/components/MessageStream-bash.test.ts` | L2：共存场景（streaming turn + bash）钉扎不断；FR-4 长输出重叠回归（happy-dom 无布局，用 mock reportHeight 模拟真实高度） |
| `packages/renderer/src/__tests__/stores/chat-bash-effects.test.ts`（新增或扩展） | L5：`bashResultEffect`/`markBashError` 调 `clearBashTimer`；L7：bash timer 回调只收口 bash 消息，不动 assistant turn |
| `packages/runtime/src/__tests__/message-converter-bash.test.ts`（扩展） | M3：构造 bashExecution entry 排在 assistant 后的 JSONL，断言还原顺序（pi flush 后顺序） |

**happy-dom 布局限制说明**：`MessageStream-bash.test.ts` 的 FR-2/FR-4（无视觉重叠）在 happy-dom 下无法测真实高度（无 ResizeObserver 布局）。测试策略：mock `useResizeReport` 的 `reportHeight`，手动喂入真实高度值（如 300px），断言 virtual list layout 的 offset 计算正确（`offsetOf(bash+1) >= bash 真实 bottom`）。真实视觉验证留 E2E/手动。

### L7: bash timer 回调解耦（修 C2，L1 前置必要条件）

**问题**：`chat-timers.ts:50-56` 的 `armBashTimer` 回调调 `finalizeSession(sessionId, 'timeout')`，`finalizeSession` 会收口该 session 所有 streaming 实体。L1 放宽并发后，共存期间 bash timer 到期会误杀正在跑的 assistant turn。

**方案**：bash timer 回调改为只收口 bash 消息，不调 `finalizeSession`。

**文件**：`packages/renderer/src/stores/chat-timers.ts`

当前 `initTimers` 的 bash timer 分支（line 47-56）：
```ts
function armBashTimer(sessionId: string): void {
  clearSessionTimer(bashTimers, sessionId)
  bashTimers.set(sessionId, setTimeout(() => {
    finalizeSession(sessionId, 'timeout')   // ← 跨域收口，问题根源
    bashTimers.delete(sessionId)
  }, BASH_TIMEOUT_MS))
}
```

改造：`initTimers` 签名新增 `finalizeBashOnly` 回调（与 `finalizeSession` 并列注入），bash timer 回调调它而不是 `finalizeSession`：
```ts
export function initTimers(
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void,
  finalizeBashOnly: (sessionId: string) => void,   // 新增
  streamingTimeoutMs: number,
) {
  // ...
  function armBashTimer(sessionId: string): void {
    clearSessionTimer(bashTimers, sessionId)
    bashTimers.set(sessionId, setTimeout(() => {
      finalizeBashOnly(sessionId)   // ← 只收口 bash，不动 streaming
      bashTimers.delete(sessionId)
    }, BASH_TIMEOUT_MS))
  }
  // ...
}
```

**`finalizeBashOnly` 实现**（`chat.ts` 新增）：找该 session 里 `status==='streaming' + bashExecution` 的消息，推到 error 态（`status:'error', bashExecution.cancelled:true, error:'timeout'`）。不调 `finalizeSession`，不碰 assistant turn，不清 streaming timer。

**与 L5 的关系**：L5 修"bash 完成时不清 timer"的遗留 bug，L7 修"timer 回调跨域收口"的设计缺陷。两者独立，但都改 `chat-timers.ts` / `chat-bash-effects.ts` 区域，建议同期提交。

### L8: abort 优先级保持现状（修 C1，零代码改动）

**问题**：共存时无统一停止入口，与 pi-tui 语义不符。

**方案**（用户决策：跟 pi-tui streaming > bash）：**保持现状**，不改代码。原因——审查后发现现状已天然符合 pi-tui 语义：

- stop 按钮调 `useChat().abort`（`useChat.ts:322`）→ 只 abort agent turn，不碰 bash（现有行为）
- BashOutputBlock 取消按钮调 `abortBash`（`useChat.ts:367`）→ 只 abort bash，不碰 streaming（现有行为）
- 共存时用户点 stop → abort streaming（bash 继续）；用户点 BashOutputBlock 取消 → abort bash（streaming 继续）

**与 pi-tui 对比**：pi-tui 的 Esc 单键优先级是 streaming > bash（先 abort streaming，再按才 abort bash）。xyz-agent 是两个独立按钮，**语义等价**（用户直接选 abort 哪个，无需优先级路由）。这反而是 GUI 下的优势——比单键优先级更直观。

**L8 实际工作**：仅文档化这个设计决策（本 spec 的 FR-9 + 已知限制），不改任何代码。若未来产品决定改为"一键停全部"或加 Esc 全局绑定，作为 W5+ 独立规划。

## 改动文件清单（修订）

| 层 | 文件 | 改动 | 风险 | 必须性 |
|---|---|---|---|---|
| **L1** | `packages/runtime/src/services/session/message-dispatcher.ts` | sendBash 预检移除 `isGenerating` | 低（pi 已支持并发） | **核心** |
| **L7** | `packages/renderer/src/stores/chat-timers.ts` + `chat.ts` | bash timer 回调改 `finalizeBashOnly`，不调 `finalizeSession` | 中（timer 核心机制） | **L1 前置** |
| **L2** | `packages/renderer/src/composables/effects/useVirtualTurnList.ts` + `MessageStream.vue` | streaming turn 钉扎（startIndex） | 中（虚拟列表核心机制） | 必须（L1 配套） |
| **L3** | `packages/renderer/src/components/panel/message-stream/BashOutputBlock.vue` | `useResizeReport` 注册（key=`s-${id}`） | 低（复用成熟基建） | 必须 |
| **L4** | `packages/renderer/src/components/panel/message-stream/BashOutputBlock.vue` | 视觉降级（极简风） | 低（纯样式） | 可选 |
| **L5** | `packages/renderer/src/stores/chat-message-effects.ts` + `chat.ts` + `chat-bash-effects.ts` | `clearBashTimer` 暴露 + 调用 | 低（接口扩展） | 必须 |
| **L6** | 多个测试文件（见上表） | 新增 + 回归 | - | 必须 |
| **L8** | 无代码改动 | 文档化 abort 决策 | 无 | 文档 |

**总改动：6 个源文件 + 测试**（L7 和 L5 共享 `chat-timers.ts`/`chat.ts` 区域；L3 和 L4 共享 BashOutputBlock.vue）。

**关键依赖顺序**：**L7 必须先于 L1 合并**（L1 放宽并发后，若 L7 未修，bash timer 会误杀 streaming）。L2/L3 是 L1 的视觉配套，同期提交。L4/L5/L8 可独立。

## 已知限制（记为 [HISTORICAL] 注释）

1. **无真实 streaming output**：pi bash RPC 不提供 onChunk / streaming events（`rpc-mode.ts:554` 传 undefined）。xyz-agent 的 bash output 永远是"等待 → 一次性结果"。streaming 态只显示 spinner + 取消按钮，无实时 output 追加。这是 pi RPC 协议限制，非本 spec 能解决。

2. **共存期间底部虚拟化退化**（M4）：L2 共存钉扎会令 streaming + bash 共存期间底部虚拟化进一步失效（SR3 已知限制的延伸）。共存是临时态，但长对话（1000+ turns）+ 用户滚中部 + 共存期间，会渲染 startIndex→lastIndex 几乎全量。需加性能回归测试（L6）。

3. **ESTIMATED_TURN_HEIGHT = 200 仍是 system 类初始估算**：实测前 system 类（含 bash）先用 200px 占位，RO 上报后立即替换。共存期间 bash 首帧用 200px 估算，RO 上报后跳变，若用户上滑脱离贴底，视口内容可能窜动（m1）。

4. **未来新 system 类视觉一致性**：本期只对齐 BashOutputBlock。SystemNotice / BgNotifyCard / GuiComponentRenderer 仍是系统级提示，与 trace block 视觉不同。

5. **isBashRunning 断连无兜底复位**（M1）：`isBashRunning` 仅在 `sendBash`/`abortBash` 的 finally 复位。session 进程崩溃时 runtime 侧无兜底复位路径（`onSessionExit` 只复位 `isGenerating`）。前端靠 `message.bashResult` 收口 bash 消息态，进程崩溃时该广播不发 → bash 消息永久 streaming（直到 L7 的 bash timer 到期收口）。L7 修复后至少有 300s 兜底，但仍非理想。彻底修复需 runtime 层在 `onSessionExit` 加 isBashRunning 复位 + 广播 bashResult 兜底，留 W5+。

6. **共存期间强杀进程导致 pending bash 丢历史**（M3）：pi 的 `_pendingBashMessages` 在 streaming 时只进内存，agent_end 才 flush 写 JSONL。若用户在共存期间强杀 pi 进程（无 agent_end），pending bash 消息永远不写 JSONL，重开时该 bash 历史丢失。这是 pi 的持久化设计，xyz-agent 无法介入。前端重开时 converter 读不到该 entry 即视为该 bash 不存在（graceful degradation）。

7. **abort 无全局 Esc 绑定**：xyz-agent 无全局 Esc→abort 路由（grep 全局 Escape handler 都是 popover/drawer 局部）。共存时用户必须点 stop 按钮或 BashOutputBlock 取消按钮，不能用 Esc。与 pi-tui 的 Esc 单键体验不同。留 W5+。

## Open Questions

1. **（OQ-1）sendMessage 预检未来若放宽，必须同步改 rpc-client**：pi 的 `prompt()` 在 `isStreaming` 时强制要求 `streamingBehavior` 参数（`agent-session.ts:1119-1126`），否则 throw。xyz-agent 的 `client.prompt`（`rpc-client.ts` 的 prompt 方法）没传。当前 sendMessage 预检因 `isGenerating` 拒绝，到不了 pi throw 的地方——本期保持这个安全网（FR-1 已明确）。**未来若放宽 sendMessage（允许 streaming 时排队新消息），必须同步给 `client.prompt` 加 `streamingBehavior` 参数**（值需与产品确认：queue/replace/cancel 语义）。这是隐藏前置条件，记录在此避免未来踩坑。

2. **（OQ-2）共存期间双 delta 过补偿风险**：L2 风险章节提到，共存期间用户上滑（非贴底）时，streaming turn 高度增长 + bash 高度变化两个 delta 都累加进同一 `scrollAdjustDelta`（`useVirtualTurnList.ts:306`）。需验证不会过补偿（视口内容相对用户滚动方向窜动）。**实现时需手动测试**：共存 + 上滑 + bash 完成（高度跳变），观察 scrollTop 是否正确。若过补偿，需在 `flushHeightReports` 加共存场景的特殊处理。

3. **（OQ-3）command 文本前缀视觉**：BashOutputBlock 渲染 command 时是否加 `$ ` 前缀（pi-tui 风格）？还是保持裸 command 文本？需确认与 user bubble 的 `!` 前缀区分度。

4. **（OQ-4）exit code 标签位置**：极简风后，exit code 标签放 header 行右侧（当前）还是改为图标（Check/XCircle，参考 Block.vue）？

5. **（OQ-5）excludeFromContext 标签**：当前是右上角 badge，极简风后改为 header 行小字还是省略（hover tooltip）？

6. **（OQ-6）取消按钮位置**：streaming 态的取消按钮当前在 header 行，极简风后是否保留可见按钮还是改为 hover 浮现？

## Acceptance Criteria

### 功能正确性
- [ ] **FR-1**：AI streaming 时（mock `isGenerating=true`），用户输 `!cmd` 不被 busy reject，bash 正常执行（扩展 `message-dispatcher-precheck.test.ts`）
- [ ] **FR-2**：共存场景下（streaming assistant turn + bash 消息），虚拟列表渲染顺序正确（bash 在 streaming turn 下方）；happy-dom 下 mock reportHeight 喂真实高度，断言 layout offset 计算无重叠（`MessageStream-bash.test.ts`）
- [ ] **FR-3**：agent turn 结束后（`isSessionActive` true→false），bash 消息在正确位置，滚动跟随正确（手动/E2E 验证）
- [ ] **FR-4**：长输出 bash（mock reportHeight 喂 300px）渲染后，下一条 item 的 offset ≥ 前置 bash 真实 bottom（`MessageStream-bash.test.ts`，happy-dom 布局限制用 mock 绕过）
- [ ] **FR-5**：BashOutputBlock 视觉风格对齐 trace block（DOM 断言：无 border、无 bg-surface-hover/40、统一 `py-2`）
- [ ] **FR-6**：`bashResultEffect` / `markBashError` 调 `clearBashTimer`，bash 完成后 300s timer 被清理（单测验证 spy 被调用）
- [ ] **FR-7**：`bashStartEffect` / `bashResultEffect` / converter / session-history 行为不变（`message-converter-bash.test.ts` 回归通过）

### L7 timer 解耦（CRITICAL 回归防护）
- [ ] **FR-8a**：共存场景下（构造 streaming assistant turn + streaming bash 消息），触发 bash timer 回调（`vi.useFakeTimers` + `vi.advanceTimersByTime(300_000)`），断言**只**有 bash 消息变 error 态，assistant turn 仍 streaming（`chat-bash-effects.test.ts` 新增）
- [ ] **FR-8b**：bash timer 回调不调 `finalizeSession`（spy `finalizeSession`，断言未被调用）

### L2 钉扎（CRITICAL 视觉防护）
- [ ] **FR-2a**：共存场景下用户向上滚动（mock scrollTop 抬升 startIndex 超过 streaming turn index），断言 streaming turn 仍在 visibleRange 内（`startIndex <= streamingTurnIdx`），未卸载（`MessageStream-bash.test.ts`）

### L8 abort（文档化决策，无代码 AC）
- [ ] **FR-9**：手动验证共存时点 stop 只 abort streaming（bash 继续）；点 BashOutputBlock 取消只 abort bash（streaming 继续）。记录在 PR 描述。

### 重开恢复（AGENTS.md 规则 7.5）
- [ ] 重开含 bash 历史的 session：bash 消息完整还原 + 视觉一致（`message-converter-bash.test.ts`）
- [ ] **pi flush 后顺序**：构造 JSONL（assistant turn entries + 排在其后的 bashExecution entry，模拟 pi agent_end flush 顺序），断言 converter 还原后 bash 在 assistant turn 之后（`message-converter-bash.test.ts` 扩展，覆盖 M3 已知限制的可还原部分）
- [ ] 共存期间强杀进程导致 pending bash 丢失：**已知限制（M3）**，不写 AC，在 PR 描述记录

### 质量
- [ ] `npx vitest run`（packages/renderer + packages/runtime）全部测试通过
- [ ] `vue-tsc --noEmit` + `eslint` 无新增告警
- [ ] 共存 + 长对话（1000+ turns）+ 用户滚中部的性能手动验证（M4 回归防护，记录渲染量）

## References

### pi 上游源码（本地 `~/GitApp/pi-ecosystem/pi-mono/`）
- bash RPC handler：`packages/coding-agent/src/modes/rpc/rpc-mode.ts:553-558`
- TUI 入口分流：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2769-2785`
- TUI bash handler + pending 视觉：`interactive-mode.ts:5905-5990`、`5947-5959`、`4086-4092`
- AgentSession.executeBash + recordBashResult + pending flush：`packages/coding-agent/src/core/agent-session.ts:2675-2703`、`2709-2733`、`2756-2768`、`1023-1035`
- LLM context 转换：`packages/coding-agent/src/core/messages.ts:148-161`（convertToLlm）
- BashExecutionComponent 渲染：`packages/coding-agent/src/modes/interactive/components/bash-execution.ts`

### xyz-agent 现状
- `packages/runtime/src/services/session/message-dispatcher.ts`（sendBash:210, abortBash:284, busy 预检:97/232）
- `packages/runtime/src/infra/pi/rpc-client.ts`（bash:486, abortBash:499，prompt 方法需关注 OQ-1）
- `packages/runtime/src/infra/pi/message-converter.ts`（bashExecution:304）
- `packages/runtime/src/services/session-history.ts`（mapEntriesToPiMessages:24）
- `packages/runtime/src/services/session/types.ts`（isBashRunning:47）
- `packages/runtime/src/services/session/session-service.ts`（onSessionExit:136-172，M1 断连复位相关）
- `packages/renderer/src/composables/panel/useComposerBash.ts`（extractBashCommand:68, trySendBash:77）
- `packages/renderer/src/composables/features/useChat.ts`（sendBash:350, abortBash:367, abort:322）
- `packages/renderer/src/components/panel/Composer.vue`（onSend:353）
- `packages/renderer/src/components/panel/message-stream/BashOutputBlock.vue`
- `packages/renderer/src/components/panel/message-stream/Block.vue`
- `packages/renderer/src/components/panel/MessageStream.vue`（bash 渲染:57-62, ESTIMATED_TURN_HEIGHT:248, scrollAdjustDelta watch:434-450）
- `packages/renderer/src/composables/effects/useVirtualTurnList.ts`（末项钉扎:230-238, editing 钉扎:240-245, itemKey:57-63, reportHeight:263-307, flushHeightReports delta:295-306）
- `packages/renderer/src/composables/effects/useResizeReport.ts`（ε 阈值:82,99, 优雅降级:107-110）
- `packages/renderer/src/composables/panel/useMessageStreamScroll.ts`（isSessionActive watch:84-89）
- `packages/renderer/src/stores/chat-bash-effects.ts`（bashStartEffect:28, bashResultEffect:53, markBashError:89）
- `packages/renderer/src/stores/chat-message-effects.ts`（MessageEffectContext:100-126, applyMessageEvent ctx 注入:634-651）
- `packages/renderer/src/stores/chat-timers.ts`（armBashTimer:50-56 ← L7 改造点, clearBashTimer:59, initTimers 签名:24）
- `packages/renderer/src/stores/chat.ts`（finalizeSession:663, initTimers 解构:742, finalizeBashOnly 新增点）
- `packages/shared/src/message.ts`（BashExecutionData:83）

### AGENTS.md 相关规则
- #7.5（对话流状态必须可重开恢复）
- #13（`.xyz-harness/` 必须提交）
- 测试规范 §5-§8（三视角 + DoD 渲染 gate）
