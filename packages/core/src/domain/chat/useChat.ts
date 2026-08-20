/**
 * useChat —— chat 业务编排（P3 chat 域 w5，createUseChat factory，core 平台无关）。
 *
 * [归位] 迁自 renderer composables/features/useChat.ts（563 行）。原样迁移 + deps 注入：
 * api 调用经 ChatApiPort（IF6）；session.* 事件处理经 sessionStore（SessionStoreLike）；
 * toast/t/useCompactQueue 经 UseChatDeps 注入。core 不 import @/api / @/stores / @/composables。
 * renderer composables/features/useChat.ts 改为薄包装（useChat()=createUseChat(rendererDeps)），
 * 20 个消费方零 import 改动（对齐 w4 createChatStore + defineStore wrapper 模式）。
 *
 * 数据流链（plan-frontend §3 UC-2）：
 *   Composer → useChat.send → store.appendUser + api.chat.send
 *            → api.transport.send(ws) → mock 回流 ServerMessage
 *            → api.events.streamSubscribe → store.applyMessageEvent（message.* 单一入口）
 *            → MessageStream 响应式渲染 + useVirtuaFollow.followIfStuck
 *
 * hydrate：首次进入 session 调 api.chat.getHistory 注入历史（含 tool_call/summary），
 * 让 UC-2 切换会话可见块类型丰富度（G2-006）。messages 为 applyEntry reducer 重放投影
 * （W20 D5，详见 hydrateHistory 注释）。
 *
 * abort：调 api.chat.abort（方法存在，中断流转 DEFERRED G-025）。
 */
import { ref } from 'vue'
import type { Segment, SessionViewSnapshot } from '@xyz-agent/shared'
import { segmentsToPrompt } from '@xyz-agent/shared'
import {
  subscribeSession,
  clearSubscription,
  invalidateSubscription,
  resetSubscriptionStates,
} from '../../coordination/subscription-state'
import type { ChatStoreInstance } from './store'
import type { ChatApiPort, WriteSegmentsFn } from './api-port'
import { splitHistoryBeforeAnchor } from './mutations'
import { createMessageCoalescer } from './delta-coalescer'

/**
 * SessionStoreLike —— useChat 消费 session store 的最小结构类型。
 *
 * 不 import 整个 SessionStoreInstance（避免 core 内 chat→session 域强耦合 + 返回类型膨胀）。
 * useChat 只用 applySnapshot 的单 session 形态（session.renamed / state_changed /
 * thinkingLevelSet 三个广播驱动的跨 store 字段更新）。结构性类型，renderer useSessionStore()
 * 返回值自动满足。
 */
export interface SessionStoreLike {
  applySnapshot(id: string, snapshot: SessionViewSnapshot): void
}

/**
 * ensureStreamSubscription 模块级函数所需 deps 子集。
 *
 * ensureStreamSubscription 是模块级导出（forkSessionAsk/selectSession/session-stream-sync
 * 复用），无法闭包拿 createUseChat 的 deps，故独立定义所需子集。renderer 同名包装注入。
 */
export interface EnsureStreamSubDeps {
  chatApi: ChatApiPort
  toast: { error: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  getCompactQueue: () => { flush: (sid: string) => Promise<boolean> }
}

/**
 * createUseChat factory 的依赖注入接口。
 *
 * - chatApi：chat 域后端唯一通道（IF6 ChatApiPort）
 * - writeSegments：写 segments.json sidecar（session 域 RPC，useChat 消费者）
 * - getChatStore/getSessionStore/getCompactQueue：getter 函数（延迟调用，规避 pinia/composable
 *   必须在 setup 上下文调用的约束；factory 调用时机与 store 实例化解耦）
 * - toast/t：壳层 UI/i18n 注入（core 不绑 toast/i18n 实现）
 */
export interface UseChatDeps {
  chatApi: ChatApiPort
  writeSegments: WriteSegmentsFn
  getChatStore: () => ChatStoreInstance
  getSessionStore: () => SessionStoreLike
  toast: { error: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  getCompactQueue: () => { flush: (sid: string) => Promise<boolean> }
}

/**
 * 会话级流式订阅表（sessionId → 取消函数）。
 *
 * [HISTORICAL] 为什么不能 per-send 订阅：
 *   原 send() 在 `await chatApi.send()` resolve 后于 finally 里 unsub。但服务端 message.send
 *   在 pi ack（prompt 已接收，非生成完成）即回 message.status{sent}，rpc-client.prompt()
 *   明确「resolves when pi acknowledges receipt (not when generation completes)」。
 *   故 finally 在首个 chunk 到达前就拆订阅 → 流式事件全丢。
 *   改为会话级长订阅：首次 send 时订阅一次，由 message_start/complete/error 驱动 streaming 状态，
 *   不在 ack 时拆订阅。
 *
 * [w5 clarify Q1 / TD2] 保持模块级 Map（不套 useSessionScopedState）：useChat 是「全局 sid
 * 协调器」（所有方法显式接收 sid，无 sidRef），与 core coordination/subscription-state.ts
 * 同模式（ADR-0049 例外：模块级单例 Map + 测试 reset）。useSessionScopedState 契约要求
 * sidRef + reactive 容器，useChat 无 sidRef 且记录的是 unsub 函数（非 reactive 状态），
 * 强行套用破坏消费方签名 + 语义错位（w4 retrospect 教训 #3：handoff 范式要求需结合代码
 * 所在层判断适用性）。
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：会话级流订阅表（ADR-0049 例外：全局 sid 协调器模块级 Map，上方注释已述）
const streamSubscriptions = new Map<string, () => void>()

/**
 * D-2 token 合帧器（W12，perf 07 §3.3.1 (7)）：模块级单例（与 streamSubscriptions 同模式）。
 *
 * 为什么模块级而非 per-subscription 实例：合帧窗口跨 sid 共享同一个 microtask
 * （异 sid 各自独立缓冲 key，互不阻塞），且 dispatch 闭包随消息携带（buffer 记首条的），
 * coalescer 自身不绑定 store 实例——多 fixture/多 store 场景天然安全。
 * 生命周期：enqueue 于 streamSubscribe 回调（下方）、flush(sid) 于 disposeSession（收口兜底）、
 * clear 于 resetChatModuleStateForTest（测试隔离）。
 */
const coalescer = createMessageCoalescer()

/**
 * W4/N1：记录哪些 session 的历史被尾读截断了（有更早的 turn 可加载）。
 * MessageStream 据此显隐「加载更多历史」按钮。hydrate 时设置。
 * 用 ref<Set> 保证响应式（MessageStream 的 computed showLoadMore 能自动更新）。
 */
// @data-owner #7 —— #7 消息列表 hydrate 派生标记（尾读截断→「加载更多」显隐；权威 = session 文件 entries）
const historyTruncatedSessions = ref<Set<string>>(new Set())

/**
 * MF-1：manual compact 的 compaction_end 到达标记（per-session）。
 * key 存在 = manual compact() in-flight；value=true = compaction_end 已到达（session.compacted
 * handler 置）。compact() catch 据此区分失败类型：ended=true（compaction 级——pi 已处理，
 * interpreter 经 message.error 进对话流，确定可见）→ 不 toast；ended=false（transport/busy 级——
 * RPC 未达 pi / dispatcher busy 预检拒绝，pi 未发 compaction_end，interpreter 不参与，零反馈）→ toast 兜底。
 * 仅 manual compact() 路径读写 key——auto-compaction 的 compaction_end handler 见 key 不在则跳过（不污染）。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：manual compact in-flight 到达标记（流程状态，非 GUI 数据）
const manualCompactionState = new Map<string, boolean>()

/**
 * 重置 useChat 模块级状态（仅供测试隔离）。
 *
 * 清 streamSubscriptions（逐个调 unsub 解除 WS 订阅 + 清 Map）+ historyTruncatedSessions
 * 重置 + resetSubscriptionStates（coordination/subscription-state 模块级 Map）。
 *
 * [TD3] handoff「resetChatModuleState 删除（cleanup 取代）」精神兑现：生产路径 session
 * 销毁由 disposeSession（已调 streamSubscriptions.delete + clearSubscription +
 * chat.disposeSession）+ triggerSessionCleanups 编排，本函数仅测试隔离用（与
 * resetSubscriptionStates 同定位）。renderer re-export as resetChatModuleState 保持
 * 旧测试 beforeEach 兼容。
 */
export function resetChatModuleStateForTest(): void {
  // 清空 stream 订阅：逐个调 unsub（解除 WS 订阅）+ 清空 Map
  for (const [, unsub] of streamSubscriptions) {
    try {
      unsub()
    // eslint-disable-next-line taste/no-silent-catch -- 测试隔离用：unsub 失败不应阻断其余订阅清理，仅记录便于诊断
    } catch (e) {
      console.warn('[useChat] stream unsub failed:', e)
    }
  }
  streamSubscriptions.clear()
  // D-2：清 coalescer 待刷缓冲——残留 buffer 会把上一用例 fixture 的 dispatch 闭包
  // （指向已 dispose 的 store）带进下一用例的 microtask flush，跨 fixture 污染。
  coalescer.clear()
  // 重置 history 截断标记
  historyTruncatedSessions.value = new Set()
  // MF-1：清 manual compact 标记（测试间不 reset 会泄漏到下一用例）
  manualCompactionState.clear()
  // wave:renderer-subscribe：重置 MessageBus 订阅状态（subscriptionStates 模块级 Map）。
  // 与 streamSubscriptions/historyTruncatedSessions 同理——测试间不 reset 会泄漏到下一用例
  //（subscriptionStates 残留 → routeInbound gap 检测误判）。
  resetSubscriptionStates()
}

/**
 * 确保指定 session 已订阅流式事件（幂等：已订阅则 no-op）。
 *
 * 导出供 forkSessionAsk/selectSession/session-stream-sync 复用：这些路径需与正常 send
 * 同样的订阅建立（否则 pi 生成的流式回复被 events.dispatchSession 静默丢弃——无订阅者）。
 * 它们不走 useChat().send：send 内部 try/catch 吞错（仅 toast）会阻断 fork 占位 session
 * 的回滚，且其 busy→steer 路由对新 fork session 不适用。
 *
 * [TD5] deps 参数：ensureStreamSubscription 是模块级函数（非 factory 内），无法闭包拿
 * createUseChat 的 deps，故接收 EnsureStreamSubDeps（chatApi/toast/t/getCompactQueue 子集）。
 * renderer composables/features/useChat.ts 导出同名包装（coreEnsureStreamSubscription 别名
 * import + 注入 renderer deps），4 复用点零改动。
 */
export function ensureStreamSubscription(
  sid: string,
  chat: ChatStoreInstance,
  sessionStore: SessionStoreLike,
  deps: EnsureStreamSubDeps,
): void {
  if (streamSubscriptions.has(sid)) return
  // wave:renderer-subscribe：升级为 subscribe + reconcile（DM4/IF8）。
  // 在 events 订阅之外，额外调 subscribeSession 建立 MessageBus 订阅：RPC 拉 snapshot 回放历史
  // （reconcile）+ 记 lastSeenSeq（routeInbound gap 检测基线）。两者职责分工：
  //   - events.on 订阅 = 消费端入口（message.*/session.* handler，UI 响应）
  //   - subscribeSession = 数据完整性层（seq 去重 + gap 补齐）
  // fire-and-forget（不 await）：ensureStreamSubscription 是同步函数（被 send/sendBash 等同步路径
  // 调用），不能改 async（破坏调用链签名）。subscribeSession 内部 catch 失败 console.warn，
  // 不标记 subscribed（下次可重试）。subscribe RPC 失败属连接级故障，WS 重连后重新建立。
  void subscribeSession(sid).catch((e) =>
    console.warn(`[useChat] subscribeSession failed for session ${sid}:`, e),
  )
  const unsub = deps.chatApi.streamSubscribe(sid, (msg) => {
    // [send.rejected] 防御性反馈通道（D-006 独立类型，不进对话流）
    if (msg.type === 'send.rejected') {
      chat.clearPendingSend(sid)
      deps.toast.error(msg.payload.message ?? deps.t('composable.agentProcessing'))
      return
    }
    // message.* → 单一入口（F2 重构：消除 double-dispatch）。
    // applyMessageEvent 内部经 effect 注册表执行该 type 的全部副作用（chunk 状态更新
    // + finalizeSession 收口），useChat 不再自己 switch message.*。message.* 处理完即 return，
    // 下方 session.* 分支仅处理跨 store 事件（compacting/renamed 等）。
    // [D-2/W12] text/thinking delta 经 coalescer microtask 合帧（同 sid 同 type 保序合并）；
    // 非 delta 消息在 coalescer 内先 flush 该 sid 缓冲再同步 dispatch（终态即时，保序）。
    // 只改 message.* 分发路径，订阅编排（streamSubscriptions/subscribeSession）不动。
    if (msg.type.startsWith('message.')) {
      coalescer.enqueue(sid, msg, (m) => chat.applyMessageEvent(sid, m))
      return
    }
    // session.* → 跨 store 协调（sessionStore.applySnapshot/setCompacting），
    // 保留在 useChat（stores 间禁止互相 import）。
    switch (msg.type) {
      // [fix-handoff-with-message] session.handoffStarted 不再处理：前端已删除「正在交接…」
      // system notice（改由 composer stop 按钮提供取消入口）。runtime 仍广播此消息，前端忽略即可。
      case 'session.compacting': {
        // #6 + M4：compact 生命周期开始（interpreter 从 compaction_start 事件唯一驱动，走 session 通道）。
        // reason 区分手动/自动，驱动 MessageStream compacting 浮层文案（M4 事件驱动核心价值）。
        chat.setCompacting(sid, true, msg.payload.reason)
        break
      }
      case 'session.compacted': {
        // #6：compact 生命周期结束（成功/失败/取消均广播）。复位态 + 标记 compaction_end 已到达。
        chat.setCompacting(sid, false)
        // MF-1：compaction_end 到达标记（供 compact() catch 区分失败类型）。仅 manual compact
        // in-flight 时标记——auto-compaction 的 compaction_end handler 见 key 不在则跳过（不污染）。
        // 成功/失败/aborted 均置 true：只要 compaction_end 到达，说明 pi 已处理 compact，结果（含错误）
        // 由 interpreter 进对话流，catch 不再 toast（避免双提示 / 对 aborted 误提示失败）。
        if (manualCompactionState.has(sid)) manualCompactionState.set(sid, true)
        // wave:compact-queued-messages：compact 成功后重放排队消息（session.compacted 无 error 字段）。
        // - error 非空（compact 失败）：仅保留队列，不 flush——错误反馈归 interpreter
        //   （compaction_end{errorMessage} → message.error 对话流），handler 不 toast（避免双提示）。
        // - error 为 undefined（compact 成功 / aborted）：flush 重放；flush 返回 false（重放 RPC 失败）→
        // toast 提示（队列保留，下次 compact 成功时重试）。
        if (msg.payload.error === undefined) {
          void deps
            .getCompactQueue()
            .flush(sid)
            .then((ok) => {
              if (!ok) deps.toast.error(deps.t('composable.queueFlushFailed'))
            })
        }
        break
      }
      case 'session.renamed': {
        // pi 改写 session 名（session_info_changed → session.renamed，见 event-adapter.ts）。
        // guard：payload.name 为空时跳过 —— 防 pi 推空名/旧名覆盖用户手动 rename 的值。
        // 用闭包 sid（对称 compacting/compacted handler）：session.* 走 session 级通道
        // (events.on(sid, ...))，payload.sessionId 恒等于订阅 sid，不信任 payload 可能的篡改。
        if (msg.payload.name) {
          sessionStore.applySnapshot(sid, { label: msg.payload.name })
        }
        break
      }
      case 'session.state_changed': {
        // 模型切换后 runtime 推送（model-service switchModel 末尾广播，含新 modelId/thinkingLevel
        // + 按新 contextWindow 重算的用量）。applySnapshot 单 session 快照按 D1b 合并
        // （undefined 字段 = 快照未涉及，不覆盖），不触发整表替换。
        // thinkingLevel optional：未设置时（undefined）不更新，保留旧值。
        if (msg.payload.sessionId) {
          sessionStore.applySnapshot(msg.payload.sessionId, {
            ...(msg.payload.modelId !== undefined && { modelId: msg.payload.modelId }),
            ...(msg.payload.thinkingLevel !== undefined && { thinkingLevel: msg.payload.thinkingLevel }),
          })
        }
        break
      }
      case 'session.thinkingLevelSet': {
        // pi 切模型 / 用户手切档位后推 thinking_level_changed（runtime event-adapter 转为此类型）。
        // 补 state_changed 的时序缺口：switchModel 的 broadcastSessionState 在 set_model RPC resolve 后
        // 立即广播，而 thinking_level_changed 事件可能晚到（异步），此时 state_changed 的 thinkingLevel 为空。
        // 本 handler 独立更新 thinkingLevel，不依赖两条消息的先后顺序。
        if (msg.payload.sessionId && msg.payload.level) {
          sessionStore.applySnapshot(msg.payload.sessionId, { thinkingLevel: msg.payload.level })
        }
        break
      }
      default:
        break
    }
  })
  streamSubscriptions.set(sid, unsub)
}

/**
 * createUseChat —— chat 业务编排 factory（P3 chat 域 w5）。
 *
 * [TD1] factory + wrapper 模式（对齐 w4 createChatStore）：core 不绑 renderer 跨域依赖，
 * 全经 UseChatDeps 注入。renderer useChat() 薄包装注入 deps，20 消费方零 churn。
 *
 * @param deps 依赖注入（chatApi/writeSegments/getChatStore/getSessionStore/toast/t/getCompactQueue）
 * @returns send/steer/followUp/abort/compact/editAndResend/hydrateHistory/loadMoreHistory/
 *          hasMoreHistory/setHistoryTruncated/disposeSession/sendBash/abortBash
 */
export function createUseChat(deps: UseChatDeps) {
  const chat = deps.getChatStore()
  const session = deps.getSessionStore()
  // ensureStreamSubscription 模块级函数所需 deps 子集（TD5）
  const subDeps: EnsureStreamSubDeps = {
    chatApi: deps.chatApi,
    toast: deps.toast,
    t: deps.t,
    getCompactQueue: deps.getCompactQueue,
  }

  /**
   * 统一发送编排器：把 segments 转成 promptText 并发送。
   *
   * 三条发送通路（send / editAndResend / 后续 landing）共享此逻辑。
   *
   * 调用方负责：appendUser / truncateFrom / pendingSend 等状态机编排
   * （submitSegments 只管「文本化 + 发送」核心步骤）：
   *   1. segmentsToPrompt（trim 后的 pi prompt 文本，image 段产出裸路径）
   *   2. 写 segments.json sidecar（clientUuid 关联，重开时回填 badge）
   *   3. chatApi.send(promptText + clientUuid 标记)
   *
   * 图片走路径模式（对齐 pi TUI）：路径已在 promptText 里（segmentsToText 产出裸路径），
   * LLM 自己调 read 工具读（vision/非 vision 模型都能处理）。不再传 images base64 字段。
   *
   * @param sessionId           目标 session
   * @param segments            结构化 segments（含 image/file/text/skill/mention）
   * @param clientUuid          调用方 appendUser 生成的 user message id（`u-<uuid>`），
   *                            用作 segments.json 主键 + prompt 标记 uuid（建立 clientUuid ↔
   *                            pi userEntryId 映射，extension input hook 剥标记后写 custom entry）
   * @param precomputedPromptText 调用方已算过的 segmentsToPrompt(segments)（trim 后非空）。
   *                            send/editAndResend 各有空检查 trim 校验（segmentsToPrompt 一次），
   *                            传入复用避免 submitSegments 内部再算一遍（S4 修复，热路径去重）。
   */
  async function submitSegments(
    sessionId: string,
    segments: Segment[],
    clientUuid: string,
    precomputedPromptText?: string,
  ): Promise<void> {
    const promptText = precomputedPromptText ?? segmentsToPrompt(segments)
    // 写 segments.json sidecar（重开 session 时回填 image/file badge 用）。
    // 异步 fire-and-forget：失败 console.warn 不阻断（sidecar 丢失只是降级为占位文本，非硬错误）。
    // landing 态 session 尚未创建时（sessionId 为占位）不写——submitFirstMessage 在 session.create 后
    // 调 chat.send，send 内部 appendUser 用已创建的 newSid，故 submitSegments 收到的 sessionId 恒有效。
    if (sessionId) {
      deps
        .writeSegments({
          sessionId,
          entry: { clientUuid, segments, timestamp: Date.now() },
        })
        .catch((e) => console.warn('[useChat] writeSegments failed:', e))
    }
    // 加 HTML 注释标记：pi extension 的 input hook 会剥离它（LLM 看不到），并建立
    // clientUuid ↔ userEntryId 映射（重开时按映射回填 segments）。
    // 标记格式严格：`<!--xyz:msg:<uuid>-->`，uuid 是 clientUuid 完整值（u-<uuid>），
    // 与 extension TAG 正则（u-[0-9a-fA-F-]{36}）+ segments.json clientUuid key 严格一致。
    const markedPromptText = `${promptText}\n<!--xyz:msg:${clientUuid}-->`
    // 图片走路径模式（对齐 pi TUI）：路径已在 promptText 里（segmentsToText 产出裸路径），
    // LLM 自己调 read 工具读。不再传 images base64 字段。
    await deps.chatApi.send(sessionId, markedPromptText)
  }

  /**
   * 发送消息：appendUser → 确保会话级订阅 → submitSegments（提取 + api.send）。
   *
   * 流式状态由会话级订阅的事件驱动（message_start→true，complete/error→false），
   * 不依赖 send() 的 resolve 时机——避免 ack 早于首个 chunk 导致订阅被提前拆除。
   *
   * dispatching 态在 send 前置位（填 isGenerating 空窗期，让 Composer 停止按钮/steer 立即可用），
   * message_start 到达时 clearPendingSend 自动清；失败也清（catch）。
   *
   * 显式接收 sessionId：双 panel 下 Composer 各自有独立 sessionId（panel leaf 绑定），
   * send 目标由调用方传入，不读全局 session.activeId（否则 standby panel 发消息会串到 active panel）。
   */
  async function send(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return

    // [B 策略 D-001] busy 时自动转 steer（追加上下文，不打断当前回合）
    if (chat.isActive(sid)) {
      await steer(sid, segments)
      return
    }

    // appendUser 返回生成的 user message id（u-<uuid>），作为 clientUuid 传给 submitSegments
    // （写 segments.json sidecar + prompt 标记，建立 clientUuid ↔ pi userEntryId 映射）。
    const clientUuid = chat.appendUser(sid, segments)
    ensureStreamSubscription(sid, chat, session, subDeps)
    chat.addPendingSend(sid)
    try {
      // S4：复用上面算过的 promptText，避免 submitSegments 内部再调一次 segmentsToPrompt。
      await submitSegments(sid, segments, clientUuid, promptText)
    } catch (e) {
      // [W2] 错误处理策略与 steer/followUp/abort 对齐：清 pendingSend + toast，不 throw。
      // 消费侧 Composer.onSend 已有 try/catch+toast 防御，此处不 throw 后 Composer 的 catch 不再触发；
      // Turn.vue submitEdit（调 editAndResend，无 try/catch）也不再产生 unhandled rejection。
      // throw 只会变 unhandled rejection，错误已通过 toast 消化。
      chat.clearPendingSend(sid)
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.sendFailed', { msg }))
    }
  }

  /**
   * 追加 steer：AI 执行中（isGenerating）时，把补充消息排入 steering 队列，
   * 当前回合工具调用结束后、下次 LLM 调用前投递，不打断当前回合。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离，不读全局 activeId。
   */
  async function steer(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || !chat.isActive(sid)) return

    // pending 气泡（S7）：steer 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败（WS 断连/steer_failed envelope/hook 拦截）回滚 pending + toast 提示，
    // 不 throw（错误已消化：pending 已回滚 + 用户已得反馈；throw 只会变 unhandled rejection）。
    chat.pushPending(sid, segments, 'steer')
    try {
      await deps.chatApi.steer(sid, promptText)
    } catch (e) {
      chat.abortPending(sid, promptText, 'steer')
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.supplementSendFailed', { msg }))
    }
  }

  /**
   * 追加 follow-up：把消息排入 followUp 队列，当前回合结束后另起一轮处理。
   * 非执行中按普通发送处理（避免 Alt+⏎ 死键）。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离。
   */
  async function followUp(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return

    // 非活跃（含空窗期）退化为普通发送，避免 Alt+⏎ 死键
    if (!chat.isActive(sid)) {
      await send(sid, segments)
      return
    }

    // pending 气泡（S7）：followUp 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败回滚 pending + toast 提示（同 steer，不 throw）。
    chat.pushPending(sid, segments, 'follow-up')
    try {
      await deps.chatApi.followUp(sid, promptText)
    } catch (e) {
      chat.abortPending(sid, promptText, 'follow-up')
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.nextTurnSendFailed', { msg }))
    }
  }

  /**
   * 中断当前回合（G-025 流转 DEFERRED：方法存在，实际中断留联调）。
   * [W3/W4] abort 乐观清 dispatching——abort 语义就是「结束当前活跃态」，即便 pi 没真正停也无害。
   * 正常成功路径由 MessageDispatcher.abort 广播的 message.complete 驱动 finalizeSession 收口；
   * 失败路径（pi 死/getClientOrThrow 抛 handler_error → abort reject）若无此 catch，dispatching 永挂。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function abort(sessionId: string): Promise<void> {
    const sid = sessionId
    // [D-008] 乐观清 pendingSend（即便 pi 没真正停也无害）
    chat.clearPendingSend(sid)
    try {
      await deps.chatApi.abort(sid)
    } catch (e) {
      // abort 失败不重抛——用户已表达「停止」意图，UI 不应因 abort RPC 失败而卡住。
      // pendingSend 已清（乐观），实体收口靠 runtime 广播 message.complete{aborted} 兜底。
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.stopFailed', { msg }))
    }
  }

  /**
   * 直接执行 bash 命令（composer-bash-execute，不经 LLM turn）。
   *
   * `!`/`!!` 前缀的 shell 文本原样透传，不走 segment 提取 / segmentsToPrompt / appendUser。
   * bash 不阻塞 active 态：与 AI turn 正交（pi bash RPC 独立执行，不抢占 LLM 回合）。
   * 实时反馈 + 结果由 message.bashStart / message.bashResult 广播驱动（runtime 负责，经
   * 会话级订阅的 applyMessageEvent 消费），故此处仅确保订阅存在 + 发 RPC。
   *
   * 错误处理与 abort/compact 对齐：toast + 不 throw（消费侧 Composer.onSend 已有 try/catch，
   * throw 只会变 unhandled rejection）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function sendBash(sessionId: string, command: string, excludeFromContext: boolean): Promise<void> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    try {
      await deps.chatApi.bash(sid, command, excludeFromContext)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.bashFailed', { msg }))
    }
  }

  /**
   * 取消进行中的 bash 执行（调 pi abort_bash）。
   *
   * 错误处理与 abort 对齐：toast + 不 throw。
   */
  async function abortBash(sessionId: string): Promise<void> {
    const sid = sessionId
    try {
      await deps.chatApi.abortBash(sid)
    } catch (e) {
      // [W2] RPC 失败时 bashResult 广播不会到达，bash 消息永久卡在 streaming。
      // 主动找到 streaming bash 消息并标记为 error 态兜底。
      // [B2 PR#116 review] abortBash RPC 失败时 bashResult 广播不会到达，bash 消息永久卡在 streaming。
      // 调 store.markStreamingBashError 找到最后 streaming bash 消息标 error 态兼底（store 持有
      // 自己的 messages ref，useChat 不碰 ref——解耦 pinia Store/factory 产物的 messages 类型鸿沟）。
      const msg = e instanceof Error ? e.message : String(e)
      chat.markStreamingBashError(sid, msg)
      deps.toast.error(deps.t('composable.stopFailed', { msg }))
    }
  }

  /**
   * 压缩上下文（#6 + M4）：确保会话级订阅（消费 session.compacting/compacted）→ 调 api.compact。
   *
   * 错误反馈（MF-1）：区分两类失败。pi 的 compact() 对失败/aborted 均 emit compaction_end 后 throw
   * （agent-session.js catch 块），故 RPC 必 reject 到此 catch。三类失败经同一 catch：
   *   - compaction 级（pi 已处理）：compaction_end{errorMessage} → interpreter 广播 message.error 进
   *     对话流（确定可见的错误源）；aborted → interpreter 视作非错误（不提示，取消语义）。compaction_end
   *     均先于 RPC error reply 经 stdout 到达 → session.compacted handler 先置 manualCompactionState=true，
   *     此处 catch 见 ended=true → 不 toast（避免与 interpreter 双提示 / 对 aborted 误提示失败）。
   *   - transport/busy 级（RPC 未达 pi / dispatcher busy 预检拒绝）：pi 未发 compaction_end，interpreter
   *     不参与 → 零反馈。此处 catch 见 ended=false → toast 兜底（AGENTS.md 规则 #3 错误必须可见）。
   * 不 throw（consumer fire-and-forget）。compacting 态由 session.compacted 复位（interpreter 发，必达）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function compact(sessionId: string, customInstructions?: string): Promise<void> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    // MF-1：标记 manual compact in-flight（key 存在），compaction_end 到达时 handler 置 value=true
    manualCompactionState.set(sid, false)
    try {
      await deps.chatApi.compact(sid, customInstructions)
    } catch (e) {
      const compactionEnded = manualCompactionState.get(sid) === true
      if (!compactionEnded) {
        // transport/busy 级失败：pi 未发 compaction_end（RPC 未达 pi / busy 预检拒绝），interpreter 不参与，
        // 零用户反馈——toast 兜底（AGENTS.md 规则 #3）。compaction 级失败由 interpreter 进对话流，不在此 toast。
        const msg = e instanceof Error ? e.message : String(e)
        deps.toast.error(deps.t('composable.compactFailed', { msg }))
      }
      console.warn(`[useChat] compact RPC failed (compaction-ended=${compactionEnded}, surfaced via ${compactionEnded ? 'interpreter/dialog flow' : 'toast fallback'})`, e)
    } finally {
      manualCompactionState.delete(sid)
    }
  }

  /**
   * 编辑 user 消息并重新发送（原地替换语义，非 fork）：
   * 截断该 user 消息（含）及其后所有 → appendUser 新 segments → 走 submitSegments 流式。
   *
   * 与 fork 的区别：fork 复制到新 session 保留原 session；editAndResend 在当前 session
   * 原地替换（删旧 user + 其后 assistant，重新发送）。UI 层用 canEdit 守卫仅最后一条 user 可编辑，
   * 避免删除中间 user 导致其后对话丢失。
   *
   * 签名变更（阶段 3a）：从 `(sessionId, userMessageId, text: string)` 改为
   * `(sessionId, userMessageId, segments: Segment[])`。调用方（Turn.vue submitEdit）
   * 负责构造 segments——从原 user message 保留 image segments + 编辑后的 text segment。
   *
   * 委托 submitSegments：与 send 同通路（segmentsToPrompt + chatApi.send），image 段
   * 经 segmentsToText 产出裸路径进 prompt 文本（不丢）。
   *
   * 显式接收 sessionId：编辑可发生在非 active 的 standby panel，不能依赖全局 activeId。
   *
   * 孤立 sidecar 条目：editAndResend 写新 clientUuid 条目，旧消息（truncateFrom 截断的）
   * 的 sidecar 条目残留。不影响功能（重开按 piEntryId→clientUuid 精确匹配，孤立条目不引用），
   * 占少量磁盘（~200B/条）。完整清理随 session 删除/压缩统一治理（YAGNI，不在本函数做）。
   */
  async function editAndResend(sessionId: string, userMessageId: string, segments: Segment[]): Promise<void> {
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || chat.isActive(sessionId)) return
    chat.truncateFrom(sessionId, userMessageId, true)
    // appendUser 返回生成的 user message id（u-<uuid>），作为 clientUuid 传给 submitSegments
    // （写 segments.json sidecar + prompt 标记，建立 clientUuid ↔ pi userEntryId 映射）。
    const clientUuid = chat.appendUser(sessionId, segments)
    ensureStreamSubscription(sessionId, chat, session, subDeps)
    chat.addPendingSend(sessionId)
    try {
      // S4：复用上面算过的 promptText，避免 submitSegments 内部再调一次 segmentsToPrompt。
      await submitSegments(sessionId, segments, clientUuid, promptText)
    } catch (e) {
      // [W2] 错误处理策略与 send/steer/followUp/abort 对齐：清 pendingSend + toast，不 throw。
      // 消费侧 Turn.vue submitEdit 无 try/catch，不 throw 避免其产生 unhandled rejection（错误已通过 toast 消化）。
      chat.clearPendingSend(sessionId)
      const msg = e instanceof Error ? e.message : String(e)
      deps.toast.error(deps.t('composable.sendFailed', { msg }))
    }
  }

  /**
   * 拉取并注入历史（首次进入 session）。
   * 无历史（空 session）也标记 hydrated，避免反复请求。
   *
   * [W20 D5 重放喂入侧] getHistory 返回的 messages 是 core applyEntry reducer 对
   * pi entry 日志的重放投影（runtime wire 层：getEntries → liftHistoryToEntries →
   * replayEntries，见 infra/pi/message-converter.ts）——hydrate 直接消费 reducer 产物，
   * 不做二次转换；getHistory RPC 链不变（session-service getEntries 增量现状保留）。
   * [W21 已接] 实时侧喂同一 reducer：message_end / tool_call_end 重构 entry 经
   * store.applyMessageEvent → applyEntryFrame 累积 per-session reducer state
   * （messages ref 的实时渲染仍走 overlay 路径，ref 与 reducer state 收敛归 W22 对账）。
   * [W5 D5] store.hydrate 内部同时记录尾窗锚（首条消息 `piEntryId ?? id`，唯一写方），
   * 供 loadMoreHistory 锚定切分——两条历史读取路径（RPC getEntries entry 树重建 /
   * 文件尾读 mapSessionEntries）都携带 entry 派生 id，边界消息身份稳定可得。
   */
  async function hydrateHistory(sessionId: string): Promise<void> {
    if (chat.isHydrated(sessionId)) return
    const { messages, historyTruncated } = await deps.chatApi.getHistory(sessionId)
    chat.hydrate(sessionId, messages)
    setHistoryTruncated(sessionId, historyTruncated)
  }

  /** N1: 查询 session 历史是否被截断（有更早的 turn 可加载） */
  function hasMoreHistory(sessionId: string): boolean {
    return historyTruncatedSessions.value.has(sessionId)
  }

  /** N1: 设置 session 历史截断标记（selectSession hydrate 时调用） */
  function setHistoryTruncated(sessionId: string, truncated: boolean): void {
    const next = new Set(historyTruncatedSessions.value)
    if (truncated) next.add(sessionId)
    else next.delete(sessionId)
    historyTruncatedSessions.value = next
  }

  /** N1: 加载更多成功后清除截断标记（已全量加载） */
  function clearHistoryTruncated(sessionId: string): void {
    if (historyTruncatedSessions.value.has(sessionId)) {
      const next = new Set(historyTruncatedSessions.value)
      next.delete(sessionId)
      historyTruncatedSessions.value = next
    }
  }

  /**
   * W4 H4：加载更多历史（fallback 全量读 + 合并去重）。
   *
   * [W5 D5 锚定切分] getFullHistory（runtime 全量文件读取，消息 id = entry 派生 uuidv7）
   * 取回后**按 hydrate 尾窗锚切分**，只把锚之前的段交给 prependHistory。为什么不能靠
   * id 去重：活跃 session 的 store 混合 live 消息（`u-`/`e<N>`/`bash-` 前缀 id）与
   * hydrate 文件侧消息（uuidv7 id），两个 id 空间**永不相等**——live 消息在文件里的
   * 对应物会被旧去重误判为新消息，重复前插、分组错乱（机制 5）。锚 = hydrate 尾窗
   * 首条的 entry 身份（store.hydrate 记录，唯一写方），锚之前的段必然不在 store 中。
   *
   * 三级定位见 mutations.splitHistoryBeforeAnchor（exact / fingerprint / none）：
   * 非 exact 即 console.warn（V6 验收：console 出现锚降级 warn = 兜底路径命中，需检查
   * compaction / 外部改写情形）；none 时 prependHistory 的 id 去重兜底仍在（安全网）。
   *
   * 幂等：切分后空段不写入（FR-4/AC-7）；锚即全量首条 = 没有更早历史，标记清除后
   * 按钮隐藏（hasMoreHistory → false）。RPC 失败不破坏现有消息（catch 吞错，与
   * hydrateHistory 的 markHistoryFailed 同策略），用户可重试。
   */
  async function loadMoreHistory(sessionId: string): Promise<void> {
    try {
      const fullHistory = await deps.chatApi.getFullHistory(sessionId)
      // 锚消息 = store 当前最旧消息：live 消息只 append 到尾部，load-more 前最旧的
      // 仍是 hydrate 尾窗首条（fingerprint 降级用其 role/首段文本/timestamp）。
      const anchor = chat.getHydrateAnchor(sessionId)
      const anchorSource = chat.getMessages(sessionId)[0]
      const { segment, strategy } = splitHistoryBeforeAnchor(fullHistory, anchor, anchorSource)
      if (strategy !== 'exact') {
        console.warn(
          `[useChat] loadMoreHistory anchor split degraded to '${strategy}' for session ${sessionId}` +
            ` (anchor=${String(anchor)}) — ${strategy === 'none' ? 'id-dedup safety net engaged (live duplicates possible)' : 'content-fingerprint located the split point'}`,
        )
      }
      chat.prependHistory(sessionId, segment)
      clearHistoryTruncated(sessionId) // N1: 全量加载后不再有更多历史
    // eslint-disable-next-line taste/no-silent-catch -- 加载更多是 best-effort：失败不破坏现有消息，用户可重试。与 hydrateHistory markHistoryFailed 同策略。
    } catch (e) {
      console.warn(`[useChat] loadMoreHistory failed for session ${sessionId}:`, e)
    }
  }

  /**
   * 清理指定 session 的全部资源（W1 / S3：deleteSession 调用）。
   *
   * 取消 WS 流式订阅（streamSubscriptions 模块级 Map）+ 清理 chat store per-session 状态
   * + 清 historyTruncatedSessions 标记。session 删除后若不取消订阅，WS 事件仍会推给已删
   * session 的 handler，且 Map 永久增长；historyTruncated 标记同理残留（SUGGESTION）。
   */
  function disposeSession(sessionId: string): void {
    const unsub = streamSubscriptions.get(sessionId)
    if (unsub) {
      unsub()
      streamSubscriptions.delete(sessionId)
    }
    // D-2：收口兜底——unsub 后不会再有新消息入缓冲，把该 sid 残留 delta 落地后再删分区。
    // 用 flush(sid) 而非 flushAll：其他 session 的合并窗口不应被本 session 的销毁提前打断。
    coalescer.flush(sessionId)
    clearHistoryTruncated(sessionId) // SUGGESTION：已删 session 的截断标记不再有意义
    manualCompactionState.delete(sessionId) // MF-1：清 manual compact 标记
    // wave:renderer-subscribe：清除 MessageBus 订阅状态（SubscriptionState）。
    // 与 streamSubscriptions.delete 配对——session 删除后若不清，routeInbound 的 gap 检测
    // 仍会读残留 state（lastSeenSeq 基线 stale），且 Map 永久增长。
    clearSubscription(sessionId)
    chat.disposeSession(sessionId)
  }

  return {
    send,
    steer,
    followUp,
    abort,
    compact,
    editAndResend,
    hydrateHistory,
    loadMoreHistory,
    hasMoreHistory,
    setHistoryTruncated,
    disposeSession,
    sendBash,
    abortBash,
  }
}

/**
 * 失效指定 session 的本地流订阅标记（session.exited 时由 useMessageEffects 调用）。
 *
 * 收到 session.exited = 服务端订阅必然已被 bus.clearSession 清除（pi 死亡 →
 * removeSessionEntry → clearSession），本地两层幂等标记必须同步失效，否则 respawn 后
 * ensureStreamSubscription 被短路，链路断裂：
 * - streamSubscriptions 条目不清 → events 层 handler 不重挂 + 残留旧 handler（若只删
 *   标记不 unsub，重挂后同 sid 双 handler 双 dispatch）；
 * - subscriptionStates 条目不清（clearSubscription）→ subscribeSession 幂等守卫
 *   （subscribed=true）短路，不重发 subscribe RPC → 新 pi 的 message.* 定向推送无订阅者，
 *   UI 卡「进行中…」而回复实际已生成。
 *
 * 与 disposeSession 的区别：session 仍存在（dead 占位 UI 可「重新打开」），只失效订阅，
 * 不清 chat store 分区/historyTruncated/manualCompaction 等业务状态。
 */
export function invalidateStreamSubscription(sessionId: string): void {
  const unsub = streamSubscriptions.get(sessionId)
  if (unsub) {
    unsub()
    streamSubscriptions.delete(sessionId)
  }
  // 收口兜底（对齐 disposeSession）：unsub 后不会再有新消息入缓冲，残留 delta 落地显示
  coalescer.flush(sessionId)
  // invalidateSubscription（非 clearSubscription）：额外清 in-flight 去重条目，防 respawn 后
  // 首次 ensureStreamSubscription 复用死 Promise 而不重发 subscribe RPC
  invalidateSubscription(sessionId)
}
