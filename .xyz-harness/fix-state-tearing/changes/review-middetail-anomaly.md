# 异常猎手审查报告 — fix-state-tearing mid-detail

> 视角：反向认知帧，专扫失败帧。焦点 = system-arch §5 状态转换路径 + §8 跨进程边界的异常路径覆盖。
> 证据源：system-architecture.md / code-architecture.md / non-functional-design.md / issues.md + 4 个 code-skeleton + 项目源码（chat.ts / chat-message-effects.ts / useChat.ts / useConnection.ts / message-dispatcher.ts / session-message-handler.ts / vite.config.ts）。
> 方法：每条扫描焦点 → 枚举触发路径 → 逐条比对"失败帧是否被设计文档/骨架/测试覆盖"。

## Verdict

**conditional_pass**（有 3 条 must_fix 阻塞实现正确性，需补齐后才能进入 dev）。

整体设计（派生模型 + finalizeSession 单一收口 + sealed guard + send.rejected 独立通道）方向正确，消除了命令式 flag 撕裂的根因。但在**失败帧的边角覆盖**上存在 3 处实现级阻塞缺陷（多 session 收口缺机制 / 错误文本丢失 / toolCall 终态映射自相矛盾）和 5 处应补齐的覆盖缺口。这些不是方向错误，是"设计文档 → 骨架/签名 → 测试"落地链路的断点——按设计文档的文字描述（如 AC: "需遍历所有 streaming session"）本意是正确的，但骨架和签名表没有给出实现锚点，实现者照骨架写会漏。

核心问题密度集中在：**finalizeSession 的多 session 收口**（#6 迁移的最大坑）、**错误文本数据流**（骨架漏参数）、**toolCall 诚实态不变式**（文档内部矛盾）。

---

## 异常路径发现

### F1. finalizeSession × 多 session 收口：useConnection 迁移缺迭代机制 [must_fix]

**路径描述**

system-arch §9 / code-arch §1 row 6 / issues #6 AC-6.1 都要求：runtime 重启/失败时 `resetActive()` → `finalizeSession(sid, 'restart'/'disconnect')`。code-arch §1 row 6 明确写「#6 AC：**需遍历当前所有 streaming session** 调 finalizeSession」。

但设计的全部交付物都没有给出"遍历所有 streaming session"的实现锚点：

1. **签名表无对应方法**（code-arch §2 模块 C）：只定义了 `finalizeSession(sessionId, reason)` 单 sid 收口，没有 `finalizeAllStreaming(reason)` 或 `getStreamingSessionIds()` 之类的迭代 helper。
2. **骨架缺 useConnection**：code-arch §7 列的 4 个骨架（protocol/chat-store/effects/usechat）不含 useConnection，而 useConnection 恰是 #6 改动落点。
3. **测试矩阵无多 session 用例**：T4.3/T4.4（useConnection restart/disconnect 收口）只测单 session，T9.12 也只验证 reason 映射，无"非 active 的 streaming session 也被收口"的断言。

**失败帧覆盖状态：未覆盖（实现级陷阱）**

对照源码可见这是真实陷阱，不是理论推演：

- 当前 `resetActive()`（chat.ts:311-322）清的是**全局单值**（isStreaming / streamingSessionId / dispatchingSessionId 三个 ref），不碰 messages[] 实体——这正是本 topic 要修的撕裂根因（flag 清了，messages[A] 的 streaming 实体残留）。
- 新模型下 isGenerating 是 per-session 派生（`messages[sid]` 扫描），**没有全局 flag 可清**，必须逐个收口实体。
- 关键场景：用户在 session A 流式中切换到 session B（A 后台流式，messages[A] 仍有 streaming 实体，源码 streamingSessionId 注释明确支持此态），此时 runtime 重启——若实现者按 `finalizeSession(session.activeId, 'restart')` 写（照搬当前 `resetActive()` 的"只清 active"心智），**A 的 streaming 实体永不被收口**，isGenerating(A) 派生 true 直到 24h timer（而 streamingTimer 是否为 A 挂载都存疑，见 F7），状态撕裂对 A 持续存在。

**严重度：高**（直接违背本 topic G1 目标"UI 与实体状态一致"；对非 active session 的撕裂不修复）

**建议**

补一个 store 级 helper 并在骨架/签名表/测试三处落地：

```ts
// chat-store-skeleton.ts 补
function finalizeAllStreaming(reason: FinalizeReason): void {
  for (const sid of messages.value.keys()) {
    if (isGenerating(sid)) finalizeSession(sid, reason)
  }
}
```

- code-arch §2 模块 C 加 `finalizeAllStreaming(reason)` 行
- code-arch §7 补 useConnection 骨架片段，onRuntimeRestarting/onRuntimeFailed 调 `finalizeAllStreaming`（非 `finalizeSession(activeId, ...)`）
- 测试矩阵补一条：多 session（A streaming 后台 + B active）+ runtime restart → A/B 实体均到终态

---

### F2. message.error / message.stream_error handler 骨架丢失 errorText 数据流 [must_fix]

**路径描述**

effects-skeleton.ts 的两个错误 handler：

```ts
'message.error': (ctx, sid) => {           // ← payload 未入参
  ctx.finalizeSession(sid, 'error')
},
'message.stream_error': (ctx, sid) => {    // ← payload 未入参
  ctx.finalizeSession(sid, 'stream_error')
},
```

`finalizeSession(sessionId, reason)` 签名（chat-store-skeleton.ts）只收 `(sid, reason)`，**无 errorText 参数**。

**失败帧覆盖状态：未覆盖（数据丢失）**

对照源码，当前 message.error handler（chat-message-effects.ts:207）读 `readString(payload, 'message') ?? 'Unknown error'` 作为 errorText，stream_error（:233）读 `readString(payload, 'content')` 作为错误内容。现行语义（设计 BC-1 / issues #3 AC-3.2 都声称"保持现行"）：

- message.error：若有 streaming assistant，把 errorText 并入其 content 后转 error；否则新建一条 content=errorText 的 error 消息（chat-message-effects.ts:206-220）。
- message.stream_error：若无前置流则合成 error 消息（content=streamErrContent）；否则追加到末条 assistant（:234-250）。

骨架把这两个 handler 简化成"只调 finalizeSession(reason)"，payload 里携带的错误文本被丢弃。finalizeSession 本身也没有"新建 error 消息"或"并入 errorText"的语义（它只对**已存在**的 streaming 实体翻终态）。结果：

- pi 发 `message.error{message: "model rate limited"}` → finalizeSession('error') 把 streaming 实体翻成 error，但 **errorText "model rate limited" 丢失**，用户看到一条空 content 的 error 气泡。
- pi 发 `message.stream_error{content: "context overflow"}` 但此 session 无前置流（prompt 级失败）→ finalizeSession('stream_error') 找不到 streaming 实体 → **no-op**，错误消息根本不进对话流（违反 AGENTS.md 规则 #3「错误必须重置 streaming + 作为消息插入聊天流」）。

effects-skeleton.ts 的注释自己也露了馅：「（并入逻辑可内聚进 finalizeSession 或在此 handler 前置）」——这个"或"是未决的实现细节，不是已定稿的契约。

**严重度：高**（错误反馈数据丢失 + 无前置流场景错误消息消失，直接影响用户可见性）

**建议**

二选一，并在签名表 + 骨架明确：

- 方案 A（推荐）：finalizeSession 增加可选 `errorText?: string` 参数，reason ∈ {error, stream_error} 时按现行语义写入（并入末条 streaming 或新建 error 消息）。handler 改 `(ctx, sid, payload)` 并提取 errorText 传入。
- 方案 B：handler 在调 finalizeSession **之前**自行完成 errorText 写入（并入/新建），finalizeSession 只负责翻终态。需在骨架把这段逻辑显式写出，不能留"或"。

无论哪种，effects-skeleton.ts 的 message.error/stream_error handler 必须恢复 `(ctx, sid, payload)` 签名并读出错误文本。

---

### F3. toolCall 终态映射：code-arch §2 表 vs NFR M8 vs 现行代码三者矛盾 [must_fix]

**路径描述**

code-arch §2 的 reason → 终态映射表：

| FinalizeReason | Message.status | ToolCall.status |
|---|---|---|
| normal | complete | **completed** |
| aborted | complete | **completed** |
| stream_error / error | error | error |
| timeout / disconnect / restart | error | end_not_received |

NFR M8 / SV-2（non-functional-design.md §#3 数据完整性 + 缓解项回灌表）：

> sealed guard **仅对 delta 流类**生效，tool_call_end 允许覆盖 **end_not_received → completed**。迟到真实 tool_call_end 携带真实 output，覆盖诚实态是正确语义。

现行 message.complete handler（chat-message-effects.ts:166-180）：

```ts
const finalizeToolCalls = (toolCalls) => toolCalls.map(c =>
  c.status === 'running'
    ? { ...c, status: isErrorStop ? 'error' : 'end_not_received', endTime: ... }
    : c
)
```

即 running toolCall 在 normal complete 时 → **end_not_received**（诚实态），等迟到 tool_call_end 覆盖。

**失败帧覆盖状态：三方矛盾，实现者无法判定**

具体矛盾场景：message.complete{agent_end} 到达，但某 toolCall 仍 running（tool_call_end 迟到或丢失）。

- 按 code-arch §2 表（normal → completed）：finalizeSession 直接把 running toolCall 翻成 **completed**（假装成功）。
- 按 NFR M8（end_not_received 是诚实态，等 tool_call_end 覆盖）：应是 **end_not_received**。
- 按现行代码（BC-1 声称保持）：running → **end_not_received**。

code-arch §2 表的"completed（tool_call_end 驱动）"注释暗示"此时 tool_call_end 已到，toolCall 自然是 completed"——但这只对**正常时序**成立。tool_call_end 迟到/丢失时，照表直翻 completed 会丢失诚实态，且后续迟到 tool_call_end 覆盖 completed → completed（看似无害），但若 tool_call_end **永不到达**，toolCall 永远显示 completed（虚假成功），违背 NFR M8 自己点名的"诚实态"设计意图。

system-arch §5 的 ToolCall 状态枚举注释也只把 end_not_received 归给 timeout/disconnect/restart，进一步固化了"normal 不会有 end_not_received"的错误前提。

**严重度：高**（文档内部矛盾导致实现分歧；选错则 toolCall 诚实态不变式破坏，工具结果可能虚假成功）

**建议**

统一为：**finalizeSession 对 running toolCall 一律映射到 end_not_received**（无论 reason），仅当 reason ∈ {stream_error, error} 时映射到 error（整个回合失败，工具也失败）。迟到 tool_call_end 的覆盖路径（M8）对 end_not_received 一视同仁，不区分 message 是 complete 还是 error。

- code-arch §2 表 normal/aborted 行的 toolCall.status 改为 `end_not_received（tool_call_end 覆盖到 completed）`，与现行代码 + NFR M8 对齐。
- system-arch §5 ToolCall 枚举注释修正：end_not_received 是"任何 running toolCall 在收口时的诚实默认态"，非 timeout/disconnect/restart 专属。
- 测试 T4.2（timeout 收口 toolCall 映射）扩展为：normal/aborted/timeout/disconnect/restart 五种 reason 下 running toolCall 都映射 end_not_received（stream_error/error 映射 error），随后注入 tool_call_end 验证覆盖。

---

### F4. dispatchingTimer（30s）被删，pendingSend 空窗期失去超时兜底 [should_fix]

**路径描述**

现行 chat.ts 有两个 timer：
- `DISPATCHING_TIMEOUT_MS = 30_000`（dispatchingTimer，:66）：覆盖 ack→message_start 空窗，pi 崩溃/静默时 30s 自动清 dispatchingSessionId，isActive 复位。
- `STREAMING_TIMEOUT_MS = 300_000`（streamingTimer，:72）：覆盖 message_start→complete。

设计删 dispatchingSessionId（pendingSend 接管），但 code-arch §1 row 3 删除清单含 `dispatchingTimer`，而 pendingSend 的生命周期里**没有任何 timer 兜底**。chat-store-skeleton.ts 的 `armStreamingTimer` 注释明确"message_start 挂载超时兜底"——即 streamingTimer 只在 message_start 后挂载。

**失败帧覆盖状态：未覆盖（auto-recovery 回归）**

pi 静默卡死场景（进程活、WS 连、不 emit）发生在 **ack 之后、message_start 之前**时：

- 当前：30s dispatchingTimer 触发 → dispatchingSessionId=null → isActive=false（UI 30s 自动恢复可操作）。
- 新设计：pendingSend.add(sid) 后无 timer；message_start 永不到 → pendingSend 永不 delete；streamingTimer 永不挂载（只在 message_start 挂）；isActive(pendingSend.has) 恒 true。
- 兜底只剩：runtime 重启（finalizeSession 'restart'）/ WS 断连（finalizeSession 'disconnect'）/ 用户手动点停止（abort clearPendingSend）。

问题：pi 静默卡死（进程活）不会触发 runtime 重启；WS 不断；用户若离开则 UI 卡 active 态**无限期**（24h streamingTimer 不覆盖此阶段）。这是相对当前 30s auto-recovery 的**实质回归**。NFR §#8 稳定性只讨论了 streaming 阶段的 24h，未承认 pendingSend 阶段失去了 30s 兜底。

**严重度：中**（auto-recovery 回归；用户离开时 UI 卡死，但用户在场可手动停止）

**建议**

三选一，并在 NFR/code-arch 明确：

- 方案 A（推荐，最贴现行）：pendingSend.add 时挂一个 30s `pendingSendTimer`，超时调 `finalizeSession(sid, 'timeout')`（兼带清 pendingSend + 实体，因实体此时还不存在所以只清 pendingSend）。
- 方案 B：把 streamingTimer 的挂载点提前到 `addPendingSend`（而非 message_start），让 24h timer 也覆盖空窗期。代价：阈值要么区分两阶段，要么统一 24h（空窗卡死要等 24h，比当前 30s 退步）。
- 方案 C：显式声明 pendingSend 阶段不设 timer，靠 runtime 重启/WS 断连/手动停止，并在 NFR 残余风险表登记"ack 后 pi 静默卡死 + 用户离开 = UI 卡 active 无限期"（接受回归）。

不能像现在这样沉默删除——至少要在 NFR 显式声明取舍。

---

### F5. STREAMING_TIMEOUT_MS 读 env 机制在 renderer 不生效 [should_fix]

**路径描述**

chat-store-skeleton.ts:

```ts
function readStreamingTimeoutMs(): number {
  const env = (typeof import.meta !== 'undefined' && import.meta.env?.XYZ_STREAMING_TIMEOUT_MS) || undefined
  ...
}
```

issues #8 AC-8.2 / NFR §#8 安全性：「XYZ_STREAMING_TIMEOUT_MS env 经 ENV_WHITELIST_PREFIXES（XYZ_ 前缀）自动过白名单」。

**失败帧覆盖状态：机制选错，feature 失效**

ENV_WHITELIST_PREFIXES 是 **runtime/Electron 主进程**的环境变量白名单（架构约束 #3，`safe-env.ts` / `rpc-client.ts` 消费），与 **Vite 客户端 bundle** 的 `import.meta.env` 暴露机制完全无关。

Vite 默认只把 `VITE_` 前缀的环境变量通过 `import.meta.env` 暴露给客户端（[Vite 文档](https://vite.dev/guide/env-and-mode.html#env-variables)）。验证：

- packages/renderer/vite.config.ts 未设 `envPrefix`（默认 `['VITE_']`），未在 `define` 注入 `XYZ_STREAMING_TIMEOUT_MS`。
- 全代码库 renderer 内 `import.meta.env.*` 的使用全部是 `VITE_` 前缀（VITE_MOCK / VITE_E2E）或内置（DEV），**零个 XYZ_ 前缀**（grep 确认）。

因此骨架的 `import.meta.env?.XYZ_STREAMING_TIMEOUT_MS` 在 renderer 永远是 `undefined`，`readStreamingTimeoutMs()` 永远返回默认 86_400_000。AC-8.2 的"env 可配置"验收在 renderer 侧根本不成立；若测试在 node/vitest 环境跑能过（vitest 不走 Vite env 过滤），但实际 Electron renderer 运行时配置失效。

**严重度：中**（默认值仍工作，但"可配置"这个 P2 enhancement 是坏的；用户设了 env 不生效且无提示）

**建议**

三选一，在 code-arch §2 + 骨架明确机制：

- 方案 A（推荐）：renderer 不读 env，改为通过 IPC 从主进程读（主进程 `process.env.XYZ_STREAMING_TIMEOUT_MS` 经 ENV_WHITELIST 合法，preload 暴露 `electronAPI.getStreamingTimeout()`）。骨架的 `readStreamingTimeoutMs` 改为调 IPC。
- 方案 B：vite.config.ts 加 `define: { 'import.meta.env.XYZ_STREAMING_TIMEOUT_MS': JSON.stringify(process.env.XYZ_STREAMING_TIMEOUT_MS ?? '') }`（构建期注入，需评估是否泄露其他 XYZ_ 变体的风险——define 是精确键，不泄露）。
- 方案 C：vite.config.ts 改 `envPrefix: ['VITE_', 'XYZ_']`（**不推荐**，会把所有 XYZ_ 变量打进 client bundle，与 ENV_WHITELIST 的最小暴露原则冲突）。

NFR §#8 安全性那句"经 ENV_WHITELIST_PREFIXES 自动过白名单"需删除或改写——那是主进程的机制，不适用于 renderer。

---

### F6. send.rejected 的 pi-catch 分类策略（SV-4）被标记需骨架验证却未写骨架 [should_fix]

**路径描述**

code-arch §2 模块 F 的 sendPrompt catch 分类：

> pi `already processing` 拒绝 → `broadcast send.rejected`（busy 语义）；其他 prompt 错误 → 保持现行 `broadcast message.error`（流终止语义）。

NFR SV-4 明确把"如何区分 pi 拒绝 vs 其他 prompt 错误"标为**需⑤骨架验证**，并自承未决：

> 区分依据：pi 拒绝的错误形态（需⑤骨架验证 pi 抛错形态，不依赖字符串匹配——D-009 已排除字符串匹配，catch 路由可能需保守处理：**所有 prompt 失败都走 send.rejected？还是仅 busy？**）。

code-arch §7 骨架覆盖核验表把 dispatcher.sendPrompt 标为"N/A（runtime 侧改动小，实现期直改；非新签名）"——**没有写骨架**。

**失败帧覆盖状态：最难的决策点被 defer 到实现期，且无验证手段**

这是整个 send.rejected 设计里最不确定的点（D-009 明确禁止字符串匹配"already processing"，但没给替代判据），却被同时标"需骨架验证"和"骨架 N/A"，形成自查矛盾。NFR 自己提的保守 fallback"所有 prompt 失败都走 send.rejected"是**错误**的——真实 prompt 错误（model not found / context overflow / API key 失效）走 send.rejected 会让用户看到一个"Agent 正在处理"的 toast，而实际是流终止级错误，错误内容也不进对话流（违反规则 #3）。

**严重度：中**（B 策略下 send.rejected 是纯防御兜底，正常路径不触发，但一旦触发且分类错，错误反馈语义全错）

**建议**

- 写一个 dispatcher-skeleton.ts，把 sendPrompt 预检 + catch 分类的骨架逻辑 stub 出来，至少 stub "如何判定 pi 拒绝"这一步（哪怕先写"判定无法可靠区分 → 走 message.error 兜底，send.rejected 只走预检路径"，也要把决策落定）。
- 在 mid-detail 收敛这个决策，不留到实现期。推荐决策：**send.rejected 只由预检触发**（runtime isGenerating=true 时拦截，不调 pi.prompt）；**catch 路径一律走现行 message.error**（pi 真拒绝了也走 message.error，因为无法可靠区分，且 message.error 是安全的流终止语义）。这样 SV-4 的"所有 prompt 失败都 send.rejected"错误选项被显式排除。
- 若采用上述推荐，code-arch §2 模块 F 的"sendPrompt catch 分类（新增分支）"整行应删除或改写（catch 不再分类，一律 message.error）。

---

### F7. useConnection 的 WS state watch（瞬态断连）路径未被 #6 迁移覆盖 [should_fix]

**路径描述**

useConnection.ts 有三个连接失败监听：

1. `onRuntimeRestarting` → `setRestarting()` + `pending.rejectAll` + `resetActive()`（→ finalizeSession 'restart'，已迁移）
2. `onRuntimeFailed` → `setFailed()` + `pending.rejectAll` + `resetActive()`（→ finalizeSession 'disconnect'，已迁移）
3. `watch(getState())`（:155-160）：`oldState==='connected' && newState!=='connected'` → `pending.rejectAll` **仅此**，**不调 resetActive/finalizeSession**。

code-arch §1 row 6 / issues #6 只迁移了前两处，第三处（瞬态 WS 断连，含网络抖动 + ws-client 自动重连场景）完全没提。

**失败帧覆盖状态：spec 与实现脱节，"disconnect" 语义模糊**

NFR §#6 并发 / 残余风险表多次提"WS 断连"作为 finalizeSession 触发源（implies 瞬态断连也应收口），但实现上第三条 watch 不收口。这导致两种解读打架：

- 解读 A（合理）：瞬态断连不应收口（ws-client 会自动重连，pi 进程仍活，流可能恢复），只有 runtime 真正失败（onRuntimeFailed）才收口。第三条 watch 只清 pending 是对的。
- 解读 B（按 NFR 字面）：所有 WS 断连都应 finalizeSession('disconnect')，第三条 watch 漏收口是 bug。

spec 不区分"瞬态断连（可恢复）"和"runtime 失败（不可恢复）"，把两者都叫"disconnect"，实现者无法判定第三条 watch 该不该加 finalizeSession。

**严重度：中**（spec 歧义；若实现者照 NFR 字面给第三条 watch 加 finalizeSession，会导致网络抖动瞬断时流被错误收口为 error，pi 实际还在生成）

**建议**

在 code-arch §1 row 6 / NFR §#6 显式声明边界：

- 瞬态 WS 断连（state watch，newState='reconnecting'）**不**触发 finalizeSession（流可能恢复，pi 仍活）；只 rejectAll pending。
- runtime 不可恢复失败（onRuntimeFailed）触发 `finalizeSession(sid, 'disconnect')`。
- runtime 重启（onRuntimeRestarting）触发 `finalizeSession(sid, 'restart')`。

并把 system-arch §5 / NFR 残余风险表里"WS 断连"措辞精确化为"runtime 失败/重启"，避免与瞬态断连混淆。

---

### F8. abort 乐观清只清 pendingSend，迟到 message_start 会让 isGenerating 翻回 true [should_fix]

**路径描述**

usechat-skeleton.ts abort：

```ts
async function abort(): Promise<void> {
  const sid = session.activeId
  if (!sid) return
  chat.clearPendingSend(sid)   // 乐观清，只清 pendingSend
  try { await chatApi.abort(sid) } catch (e) { toast }
}
```

**失败帧覆盖状态：未覆盖（abort 后实体复活）**

竞态：用户在 pendingSend 阶段（ack 已到、message_start 未到）点停止。

1. `clearPendingSend(sid)` → pendingSend 无 sid，isActive 派生 false（此时实体还未创建）。
2. `chatApi.abort` RPC 在途。
3. pi 实际已经开始生成（abort RPC 未赶上），emit message_start。
4. effects message_start handler：创建 streaming 实体 + `clearPendingSend`（no-op）。
5. isGenerating(sid) 派生 **true**（实体 streaming），isActive **再次 true**。

用户刚点了停止，UI 却显示"生成中"。abort 的 runtime 广播（message.complete{aborted}）最终会到 → finalizeSession('aborted') 收口，瞬态可接受。但若 **abort RPC 失败**（pi 死 getClient 抛），runtime 不广播，实体靠 runtime 重启/WS 断连兜底（最长 24h，见 F4）——用户点了停止，AI 却继续"生成"最长 24h。

这本质是 BC-2 保持的现行行为（abort 失败靠广播兜底），不是新引入 bug，但设计的"乐观清"措辞容易让实现者误以为 abort 是纯本地操作。骨架注释也只说"pendingSend 已清，实体残留靠 runtime 广播兜底"，未点明 isGenerating 会因迟到 message_start 翻回 true 这一具体瞬态。

**严重度：低-中**（行为保持，但 spec 措辞误导风险；abort RPC 失败 + pi 已开始生成 = 用户可见的"停止无效"）

**建议**

- 在 usechat-skeleton.ts abort 注释 + BC-2 显式说明：abort 后若 message_start 已在途，isGenerating 会瞬态翻 true，靠 runtime message.complete{aborted} 收口；abort RPC 失败且 pi 已开始生成时，实体最长卡 24h（与 F4 的 pendingSend 卡死同源，可合并解决）。
- 可选增强：abort catch 里，若错误是"getClient 失败/Session not found"类（pi 已死），主动调 `finalizeSession(sid, 'aborted')` 本地收口，不等广播。但这扩大了改动范围，标 should_fix 即可。

---

## must_fix

| # | 发现 | 核心问题 | 修复锚点 |
|---|------|---------|---------|
| M1 | F1 | useConnection 多 session 收口：AC 要求遍历所有 streaming session，但无 helper/骨架/测试支撑。照骨架直写只收口 active session，非 active 后台 streaming session 撕裂持续（违背 G1） | 加 `finalizeAllStreaming(reason)` store helper + useConnection 骨架 + 多 session 测试用例 |
| M2 | F2 | message.error/stream_error handler 骨架丢 payload，finalizeSession 无 errorText 参数。错误文本丢失 + 无前置流场景错误消息不进对话流（违反规则 #3） | finalizeSession 加 `errorText?` 参数 或 handler 前置写入；骨架恢复 `(ctx,sid,payload)` 签名 |
| M3 | F3 | toolCall 终态映射：code-arch §2 表（normal/aborted→completed）与 NFR M8（end_not_received 诚实态）+ 现行代码（running→end_not_received）矛盾。tool_call_end 迟到/丢失时 toolCall 虚假 completed | 统一：running toolCall 收口时一律 → end_not_received（error/stream_error → error）；迟到 tool_call_end 覆盖。改 code-arch §2 表 + system-arch §5 注释 |

## should_fix

| # | 发现 | 核心问题 | 修复锚点 |
|---|------|---------|---------|
| S1 | F4 | dispatchingTimer（30s）删除后，pendingSend 空窗期（ack→message_start）无超时兜底。pi 静默卡死在 ack 后 → isActive 恒 true 无限期（24h streamingTimer 不覆盖此阶段）。相对当前 30s auto-recovery 是回归 | 加 pendingSend 阶段 30s timer，或 streamingTimer 提前到 addPendingSend 挂载，或 NFR 显式声明接受回归 |
| S2 | F5 | `import.meta.env.XYZ_STREAMING_TIMEOUT_MS` 在 Vite renderer 不生效（无 envPrefix/define 配置，全库零 XYZ_ 前缀先例）。AC-8.2"可配置"在 renderer 运行时失效，永远走默认 24h | 改 IPC 读主进程 env，或 vite.config define 精确注入；删除 NFR"经 ENV_WHITELIST 自动过白名单"误述 |
| S3 | F6 | send.rejected 的 pi-catch 分类（SV-4）被标"需骨架验证"却未写骨架（dispatcher 骨架 N/A）。最难决策点 defer 到实现期，NFR 自承的保守 fallback"所有 prompt 失败走 send.rejected"是错的 | 补 dispatcher-skeleton，或在 mid-detail 收敛决策（推荐：catch 一律 message.error，send.rejected 只走预检） |
| S4 | F7 | useConnection 第三条监听（WS state watch，瞬态断连）未纳入 #6 迁移，spec 不区分"瞬态断连可恢复"与"runtime 失败不可恢复"，"disconnect"语义模糊 | code-arch/NFR 显式声明：瞬态断连不收口（只 rejectAll），runtime 失败/重启才 finalizeSession；精确化"WS 断连"措辞 |
| S5 | F8 | abort 乐观清只清 pendingSend，迟到 message_start 让 isGenerating 翻回 true。"乐观清"措辞易误导实现者；abort RPC 失败 + pi 已开始生成 = 用户可见"停止无效"最长 24h | BC-2/骨架注释显式说明瞬态；可选 abort catch 里 pi 已死时本地 finalizeSession('aborted') |

---

## 附：已验证良好的失败帧覆盖（确认无异常）

以下焦点经核查覆盖完整，列出以示已审：

- **sealed guard × tool_call_end 覆盖（扫描焦点 2）**：effects-skeleton.ts tool_call_end 显式不 sealed，允许覆盖 end_not_received → completed，与 NFR M8/SV-2 一致。tool_call_end 用 findToolCallOwner 按 ID 锚定（源码 chat-message-effects.ts:345-370），跨 message 精确定位，不误伤。✓
- **send.rejected × useChat 监听（扫描焦点 3 的 renderer 侧）**：usechat-skeleton.ts ensureStreamSubscription 显式加 send.rejected 分支（clearPendingSend + toast），且 send.rejected payload 有 sessionId → 经 routeInbound dispatchSession 路由到 session 通道（useConnection.ts:71-77），订阅在 chatApi.send 之前建立（send 流程 ensureStreamSubscription 先于 addPendingSend/api.send），时序正确。✓
- **finalizeSession 幂等（多路径并发基础）**：sealed 不变式 + Set delete 幂等 + clearTimeout，单线程 JS 下事件顺序竞态由 sealed guard 兜底（AC-2.5 / M4 / SV-3）。✓（注：幂等性本身 OK，但 F1 的多 session 遍历缺失是另一问题）
- **WS 重连 × hydrate 冲突（扫描焦点 6）**：hydrate 有 `hydrated` Set 守卫（chat.ts:101 `if (hydrated.value.has(sessionId)) return`），重连后不会 re-hydrate 覆盖 finalizeSession 的 error 态。✓
