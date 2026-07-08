# mid-plan 独立重建审查（fix-state-tearing）

> 审查帧：反向认知。先从源码独立重建该有哪些需求/架构，再 diff 主 agent 初稿
> （requirements.md + system-architecture.md）。禁读重建阶段已遵守。

## Verdict

**CHANGES_REQUESTED**

主体方向（派生模型 / finalizeSession 统一收口 / send.rejected 正交通道 / pendingSend
接管空窗期）与源码暴露的撕裂根因高度吻合，D-001~D-007 决策对齐。但有 4 条 MISSING
会在 issues 拆分 / dev 阶段造成路径遗漏（editAndResend / stream_error / landing /
per-session 派生签名），1 条 PHANTOM 把新功能混入 refactor 范围需确认，3 条 MISMATCH
描述不精确会导致 effects 改造和 resetActive 迁移漏改。修订后可进入 mid-detail-plan。

## 重建结论（独立推导的需求/架构要点）

### 源码暴露的撕裂根因（重建依据）

1. **命令式 flag 三件套手动同步**：`isStreaming`(全局) + `streamingSessionId`(per-session)
   + `dispatchingSessionId`(空窗) 三个 ref，由 `setStreaming` / `setDispatching` /
   `resetActive` 三个 mutation 入口分别翻转，时序耦合。
2. **三处独立 `setStreaming(false)`**：effects 注册表里 `message.complete` / `message.error`
   / `message.stream_error` 各调一次——漏一处即 flag 永挂。
3. **streamingTimer 假收口**（D-007 根因）：5min timer callback 只翻 `isStreaming=false`
   + 清 `streamingSessionId`，**不碰 messages[] 实体**——实体仍 streaming，flag 与实体撕裂。
4. **dispatching 空窗 + 30s timer 补丁**：ack→message_start 空窗靠 dispatchingSessionId
   填补，附带 30s 超时 timer + 多处 catch 清理路径，生命周期复杂。
5. **message.error 双重语义**（D-006 根因）：`message-dispatcher.sendPrompt` prompt 失败
   广播 `message.error`（操作拒绝/发送失败），与 pi 真正的流错误（effects message.error
   handler）共用同一 WS 类型 → 进对话流 + 翻流式态，污染。
6. **B 策略缺口**：Composer `canSend = hasInput && !isActive && ...`，`send()` 内
   `if (!isActive) return` 前还有 `if (chat.isActive(sid)) return`——busy 时发送被
   静默丢弃，无反馈。

### 独立推导的需求（用户场景）

| UC | 场景 | 成功标准 |
|----|------|---------|
| UC-1 | 正常 send baseline | 行为等价，complete 必收口 |
| UC-2 | steer / followUp 追加（busy） | pending 气泡 + 投递转 complete + 失败回滚 |
| UC-3 | abort（含 pi 卡死兜底） | runtime abort 失败广播 message.error 也能收口 |
| UC-4 | runtime 崩溃 / WS 断连 | resetActive 等价物立即清，不卡死 |
| UC-5 | 长任务 >5min 不误杀 | 超时阈值实质禁用（24h），靠崩溃事件收口 |
| UC-6 | agent 忙时显式分流（B 策略） | send 被拒走 send.rejected，非静默丢弃 |
| UC-7 | **editAndResend 编辑重发** | dispatching/pendingSend 生命周期与 send 对称 |
| UC-8 | **message.stream_error**（pi 发 error 不发 agent_end） | 第三条终态路径也经收口 |
| UC-9 | **landing 首发 submitFirstMessage** | create+send 流程空窗期被覆盖 |

### 独立推导的架构要点

- **派生模型**：`isGenerating(sid) = computed(∃ msg.status==='streaming' in messages[sid])`，
  per-session 查询（防跨 session 误伤，源码 streamingSessionId 注释已点明此约束）。
- **统一收口 finalizeSession(sid, reason)**：取代三处 setStreaming(false) + resetActive
  + streamingTimer 假收口；级联收口 streaming message + running toolCall + 清 pendingSend。
- **send.rejected 独立通道**：runtime already-processing / prompt 失败改发 send.rejected，
  不进对话流、不翻流式态。
- **pendingSend 取代 dispatchingSessionId**：空窗预期态，add 在 send 前、delete 在
  message_start（正常）/ finalizeSession（异常）。
- **message.complete 由 agent_end 独占保留**（event-interpreter turn-end，不动）。
- **abort 收口模式**：前端 useChat.abort 仍靠 runtime 广播 message.complete{aborted}
  收口（非前端乐观调 finalizeSession），与源码当前"乐观清 dispatching + runtime 兜底"
  模式保持。

## 三态 gap

### MISSING（漏项：源码暴露但初稿没有）

**M1 [F] editAndResend 路径完全未覆盖**
- 证据：`useChat.ts` `editAndResend()` 是独立 send 路径（`truncateFrom` → `appendUser`
  → `setDispatching(sessionId)` → `api.send` → catch `setDispatching(null)`），有完整
  dispatching 生命周期 + `isActive(sessionId)` 守卫。
- 初稿：requirements §4 功能清单、architecture §7 模块划分、§12 BC 清单均未提及。
- 影响：派生模型重构时，editAndResend 的 pendingSend add/delete 时序需同步迁移，
  遗漏会漏改一条 send 路径，isActive 守卫迁移也会漏。BC 清单缺一条行为等价基线。
- 建议：requirements UC 补 UC-7；architecture §7 useChat 行补"editAndResend pendingSend
  迁移"；§12 补 BC-editAndResend。

**M2 [F] message.stream_error 终态路径未纳入收口覆盖清单**
- 证据：`chat-message-effects.ts` `message.stream_error` handler 调 `setStreaming(false)`，
  这是独立于 complete / message.error 的第三条终态路径（pi `message_update{error}` 不发
  agent_end 的场景，handler 注释 FR-5 明确）。
- 初稿：architecture §5 状态流转只画 `streaming→complete|error` 两个终态；§9 泳道图
  只列"超时/断连/abort"异常路径；AC-3 "所有异常收口经 finalizeSession" 只点名
  "超时/断连/重启/abort 四条路径"。
- 影响：AC-3 漏了 stream_error 和 message.error 两条事件驱动终态。effects 改造时
  message.stream_error handler 的 setStreaming→finalizeSession 迁移会被遗漏。
- 建议：AC-3 路径清单补 `message.error` / `message.stream_error`；§5 reason 字段
  补 `stream_error`（已有但 state diagram 未画该弧）。

**M3 [F] isGenerating 派生签名（per-session vs 全局）未定义**
- 证据：源码 `streamingSessionId` 注释明确"per-session 视图，不能用全局 isStreaming——
  否则 A 会话流式时切到空 session，空 session Landing 被全局 isStreaming 误伤"。
  `isActive(sessionId)` 也是 per-session 查询。
- 初稿：architecture §4 模型表 `isGenerating ≡ ∃ message.status=streaming`，未标
  per-session 还是全局；§3 术语表 isActive(sid) 是 per-session 但 isGenerating 签名缺。
- 影响：实现时若 isGenerating 实现为全局单值（任意 session 有 streaming 即 true），
  会重蹈源码注释警告的跨 session 误伤。Composer/Panel 守卫需 per-session。
- 建议：§4 模型表 isGenerating 明确为 `isGenerating(sid): boolean`（per-session scan），
  或拆 `isGeneratingGlobal`（全局，store 顶层用）+ `isGenerating(sid)`（per-session，
  UI 守卫用）。

**M4 [F] landing 态首发（submitFirstMessage）空窗期归属未明**
- 证据：`Composer.vue` `onSend` landing 态走 `flow.submitFirstMessage`，其 isSending 是
  Composer 本地 ref，但 create+send 流程中存在 ack→message_start 空窗。
- 初稿：未提 landing 态。
- 影响：pendingSend 接管空窗期后，landing 首发（延迟 create session → send）的空窗
  是否由 pendingSend 覆盖？create 前无 sessionId，pendingSend.add 时机需明确。
- 建议：requirements UC 补 landing 首发；architecture §7 useChat 行注明 submitFirstMessage
  的 pendingSend 时机（create 后 add）。

### PHANTOM（脱锡：初稿有但源码不支持/范围越界）

**P1 [F/K] D-6 + F4「鼠标发送按钮 busy 时转 steer」是新功能，混入 refactor 范围**
- 证据：源码 `Composer.vue` busy 时（`isActive=true`）渲染的是 `<Button stop>`（v-if
  isActive 分支），发送按钮在 `v-else-if` 链尾，**busy 时根本不渲染发送按钮**。D-6 要
  "鼠标发送按钮 busy 时改为可点 → 触发 steer"需重构模板三态（停止 + 发送同时可见？
  或停止位变 steer 位？），属新增交互逻辑。
- 初稿：architecture §10 D-6 自承"与键盘 Enter 对齐"，是行为变更非等价；但文档 mode
  标 `refactor`、§8 "不加新 UI 组件"。D-6 与 refactor 定位 + "不加 UI"约束有张力。
- 影响：把新交互塞进状态撕裂 refactor，扩大范围、增加回归面，且与"不加新 UI 组件"
  约束冲突。鼠标/键盘对齐是合理的 UX 改进，但应独立 ticket 或显式标为搭便车新功能。
- 建议：确认 D-6/F4 是否纳入本 topic。若纳入，requirements §1 mode 补"含 B 策略鼠标
  路由新交互"，§8 "不加新 UI 组件" 例外说明；若不纳入，移至独立 ticket，本 topic 只
  保证键盘 Enter 路径不退化。

### MISMATCH（虚覆盖：标了但描述不准确）

**MM1 [F] AC-3「resetActive 无输出」缺 resetActive 调用方迁移指引**
- 证据：源码 `resetActive()` 由 `useConnection` 在 runtime 崩溃/重启/WS 断连时调用
  （store 注释明确）。AC-3 要求 grep resetActive 无输出 = resetActive 被删除/改名。
- 初稿：AC-3 只说"resetActive 无输出，finalizeSession 覆盖四条路径"，但未点明
  **resetActive 的调用方（useConnection）需迁移到调 finalizeSession**。BC-4 说
  "dispatching 空窗行为保持"但没说 resetActive→finalizeSession 迁移。
- 影响：实现时只删 resetActive 不改 useConnection，runtime 崩溃路径断链。
- 建议：AC-3 补"useConnection 的 resetActive 调用迁移到 finalizeSession('restart'/'disconnect')"。

**MM2 [F] §5 / §7 message.error handler 改造方式未点明**
- 证据：D-006 收窄 message.error 语义后，effects `message.error` handler 仍是流终止
  事件（pi 真正的流错误），应走 finalizeSession('stream_error' 或 'error')。
- 初稿：§7 说"chat-message-effects.ts：删 setStreaming 调用，message.error 收窄语义"，
  但没说 handler 内部改调 finalizeSession 还是只改实体 status。§5 state diagram 把
  `message.error / finalizeSession(reason)` 并列画在 `streaming→error` 弧上，语义模糊。
- 影响：effects 改造时 message.error handler 可能只删 setStreaming 不接 finalizeSession，
  导致实体未收口、isGenerating 派生仍 true。
- 建议：§7 明确"message.error / message.stream_error handler 内部改调
  finalizeSession(sid, 'stream_error')"；§5 state diagram 把 message.error 标为
  finalizeSession 的触发源之一。

**MM3 [F] §4 pendingSend「delete 在 message_start/收口时」——正常路径生命周期未画全**
- 证据：源码 `setStreaming(true)` 在 message_start 到达时清 dispatchingSessionId
  （clearDispatchingTimer + 置 null）。迁移后 pendingSend.delete 应在 message_start
  effect handler 内。
- 初稿：§4 模型表 pendingSend "delete 在 message_start/收口时"；但 §9 泳道图只画了
  异常路径（abort/超时/重启）的 pendingSend.delete，正常路径 message_start →
  pendingSend.delete 没画。§7 effects 改造说明也未提 message_start handler 加
  pendingSend.delete。
- 影响：实现时 message_start handler 漏加 pendingSend.delete，正常路径空窗态残留。
- 建议：§9 补正常路径泳道（message_start → pendingSend.delete + 实体 streaming）；
  §7 effects message_start handler 改造点补 pendingSend.delete。

**MM4 [K] BC-2「abort 改调 finalizeSession」前端乐观 vs runtime 广播模式未区分**
- 证据：源码 `useChat.abort` 是乐观清 dispatching（`setDispatching(null)`），streaming
  靠 runtime `message-dispatcher.abort` 广播的 `message.complete{aborted}` 收口
  （effects handler）。前端不直接 finalizeSession。
- 初稿：BC-2 "abort 改调 finalizeSession，外部行为等价"——未区分是前端 useChat.abort
  显式调 finalizeSession（乐观收口），还是仍靠 runtime 广播 message.complete → effects
  finalizeSession。
- 影响：若理解为前端乐观调 finalizeSession，会与"靠 runtime 兜底"的现有健壮性设计
  （pi 卡死时 runtime abort 失败仍广播 message.error 收口）冲突。需明确保持
  "前端乐观清 pendingSend + runtime 广播兜底收口"模式。
- 建议：BC-2 注明"前端 abort 乐观清 pendingSend（非 finalizeSession 实体），实体收口
  仍由 runtime 广播 message.complete{aborted} → effects finalizeSession 兜底"。

---

## 标记说明

- **F（事实性）**：源码可证伪的遗漏/错误，必须修订
- **K（需确认）**：涉及范围/语义边界判断，需问用户或主 agent 确认
- **D（agent 自决）**：实现细节，可在 detail-plan 阶段定

> 所有 M1~M4、MM1~MM3 标 F（源码可证伪，须修订）；P1、MM4 标 F/K（范围/模式判断，
> 需确认后修订）。无 D 类（本阶段不涉及实现细节自决）。
