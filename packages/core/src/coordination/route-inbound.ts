/**
 * route-inbound —— 入站消息分发器（迁移自 renderer useConnection.ts routeInbound，IF1/IF2/IF4 + DM3）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolveEnvelope 委托 pending 层（envelope 展开，ES1）→ return（D7）
 *   2. 查 ROUTE_TABLE 精确 type 条目（session.exited/message.complete/session.subagents/
 *      session.workflowUpdate）：seq gap 中间件（evalSeqGap + 副作用）→ dispatchSession →
 *      effect 回调
 *   3. 恒真 FALLBACK 兜底：有 sessionId → seq gap 中间件 + dispatchSession（未注册 type 落
 *      现状语义）；无 sessionId → dispatchGlobal + L9 warn（session./message. 前缀）+
 *      error 无 id → effects.onGlobalError
 *
 * session 隔离规则不变（CLAUDE.md line 98）：session 级消息按 sessionId 路由到 session 通道，
 * 无 sessionId 走 global 通道（config.* 及 model.list 等广播）。两通道互不串扰。
 *
 * seq gap 检测（D7 id/seq 互斥）：msg.seq 是 server-push live 事件的序号（per-session，
 * bus.publish 分配）。对已 subscribe 的 session（SubscriptionState.subscribed=true）：
 *   - seq <= lastSeenSeq → 丢弃（reconcile 回放的重复或乱序）
 *   - seq > lastSeenSeq+1 → 触发 subscribeSession(sid, lastSeenSeq) reconcile（ES2 失败兜底），
 *     当前 msg 仍 dispatch（基线不在此推进，MF-3：reconcile 成功后才推进）
 *   - seq === lastSeenSeq+1 → 正常递进，dispatch + 更新 lastSeenSeq
 * 未 subscribe 的 session（state 不存在或 subscribed=false）不做 gap 检测，正常 dispatch
 * （渐进迁移，remove-bandaids wave 统一）。pending 路径（msg.id 分支）不受 seq 影响——
 * id/seq 来源互斥（D7）。
 *
 * core 零 import renderer：renderer 的 WS 能力（pending/events/subscribe）经 TransportPorts
 * 注入（TC2/TC3 一次性注入三件套），effect 兜底经 InboundEffects 注入（undefined 跳过）。
 */
import type { PiEntry, PiToolCallEntryForm, ServerMessage, ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'
import { evalSeqGap } from './seq-gap'
import {
  getSubscriptionState,
  subscribeSession,
  updateLastSeenSeq,
  setSubscriptionPorts,
  recordGapDispatchedSeq,
} from './subscription-state'

// ── 端口契约（IF1） ────────────────────────────────────────────────

/**
 * core 与 renderer 的 WS 能力边界（IF1）。
 *
 * renderer 注入实现：
 * - pending → renderer api/pending 的 resolve/reject/rejectAll
 * - events → renderer api/events 的 dispatchSession/dispatchGlobal
 * - subscribe → renderer api/domains/session.subscribe（签名对齐
 *   ReplyPayloadMap['session.subscribe'] 的 reply 形状）
 *
 * 所有字段必填（subscribe 必须提供，gap 检测副作用依赖它）。
 */
export interface TransportPorts {
  pending: {
    resolve(id: string, payload: unknown): void
    reject(id: string, error: unknown): void
    rejectAll(error: unknown): void
    /** 该 id 是否对应一个 pending 请求（区分 RPC reply 与带 id 的广播，见 routeInbound 注释）。 */
    has(id: string): boolean
    /**
     * 按 envelope 语义 settle pending 请求（收尾 6：envelope 展开下沉 pending 层，R2/ES1）。
     *
     * 接受原始 ServerMessage：id 命中 pending 时——
     * - type==='error'：展开 error envelope（code 提取 + details.detail 展开到 Error）后 reject；
     * - 其他 type：resolve msg.payload 原样。
     * id 缺失或未命中 pending（如带 nextPushId 的广播）→ no-op，绝不吞广播。
     * 实现位于 renderer api/pending（route-inbound 的 pending 分流出口）。
     */
    resolveEnvelope(msg: ServerMessage): void
  }
  events: {
    dispatchSession(sessionId: string, msg: ServerMessage): void
    dispatchGlobal(msg: ServerMessage): void
    /** 带 sid 消息的全局消费者分发（ADR-0060 crossSession 通道）。 */
    dispatchCrossSession(msg: ServerMessage): void
  }
  subscribe(
    sessionId: string,
    fromSeq?: number,
  ): Promise<{ snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }>
}

/**
 * 路由表命中的 effect 类兜底回调集（IF2，全部可选）。
 *
 * 路由表条目在 dispatchSession/dispatchGlobal 之后调用对应回调；undefined 跳过。
 * renderer 侧（W2）把现有 useConnection 实现
 * （handleSessionExited/handleCompletion/applyRecords/triggerWorkflowReload/toast）注册进来，
 * 行为与现状一致。
 */
export interface InboundEffects {
  onSessionExited?(sessionId: string, payload: { code: number | null; reason: string }): void
  onMessageComplete?(sessionId: string, payload: { sessionId?: string; stopReason?: string }): void
  onSubagents?(sessionId: string, subagents: SubagentRecord[]): void
  /**
   * [E-4] subagent entry 帧兜底消费（session.subagentEntriesAppended，relay tee 产出）。
   *
   * 与 onSubagents 同定位：在所有 session（含非活跃）生效——帧先于 drawer 打开到达时
   * 也要写虚拟分区（§6.1 分区惰性创建），不能依赖 per-focus 订阅。renderer 实现经
   * subagentVirtualId(sessionId, subagentId) 构造虚拟分区 id 后调 chatStore.applySubagentEntries。
   */
  onSubagentEntries?(
    sessionId: string,
    subagentId: string,
    entries: Array<PiEntry | PiToolCallEntryForm>,
  ): void
  onWorkflowUpdate?(sessionId: string, update: ServerMessageMap['session.workflowUpdate']['update']): void
  /**
   * [idle-refresh] subagent.stream_delta 帧桥接（docs/design/timeout-streaming-ui-idle.md §5.1 D1 / §6）。
   *
   * sync subagent/workflow 编排期父 session 的 message.* 帧构造性为零（生产端
   * executeSubagent 不消费 onUpdate），子代理活跃信号走本帧旁路（relay tee / 旧
   * widget 通道，不经 chat store.applyMessageEvent）。本回调在 routeInbound FALLBACK
   * 路径按 type 识别后调用（该 type 不在 ROUTE_TABLE/CROSS_SESSION_TYPES，帧与
   * payload.sessionId 在挂载点完全可见；pending 分流不拦截（旁路帧无 pending id），seq gap 与 session 通道同 gate——gap drop 帧不触发刷新，route-inbound.test.ts 锁定）。
   *
   * 实现方（renderer 装配层，useMessageEffects 范本）：解析 payload.sessionId
   * （shared resolveSubagentParentSessionId——三段式虚拟 id `subagent:<mainSessionId>:<subagentId>`
   * 提取父 sid / 旧 widget 通道主 sid 原样，双形态兼容，纯字符串函数零失败模式）
   * → 调 chatStore.refreshStreamingTimer(父sid)，防「子面板在打字、父气泡被判无进展」。
   * 非 subagent.stream_delta 类型帧不调用（type guard 在 FALLBACK 挂载点）。
   */
  onSubagentStreamDelta?(frame: ServerMessage): void
  onGlobalError?(message: string): void
  /**
   * 带 sessionId、未命中 pending 的 error envelope 兜底（D6b，integrity-hardening §3.6）。
   *
   * 到达此处的只剩 fire-and-forget 路径的失败（请求级失败带 msg.id，已在 pending 分流
   * reject）——典型：extension.ui_response 目标 session 无进程（pi 死后残留弹窗的作答）。
   * 此前这类消息落 session 通道后被静默丢弃（无 'error' type 消费者），用户作答石沉大海；
   * 现经 effect 进消息流 error 展示。
   */
  onSessionError?(sessionId: string, payload: { code?: string; message?: string }): void
}

// ── ROUTE_TABLE（DM3） ─────────────────────────────────────────────

/**
 * 路由表条目：精确 type 字符串匹配（TC1）。
 *
 * handle 内部：seq gap 中间件（session 通道）→ dispatchSession → effect 回调。
 * type 即 Record key（type 互斥，精确匹配同一消息只命中一条）。
 */
type RouteTableEntry = {
  handle: (msg: ServerMessage, ctx: RouteContext) => void
}

/** 路由执行上下文：注入端口 + effects + 从 payload 提取的 sessionId（可选）。 */
interface RouteContext {
  ports: TransportPorts
  effects: InboundEffects
  sid?: string
}

/**
 * seq gap 中间件（IF3 副作用执行点）。
 *
 * evalSeqGap 是纯函数（不碰状态），副作用在此执行：
 * - drop → 返回 false（不 dispatch 不更新基线不触发兜底）
 * - pass 带 reconcileFromSeq → void fire-and-forget subscribeSession(sid, lastSeenSeq) 回拉缺失段
 *   （失败由 subscribeSession 内部 console.warn 消化，ES2；基线不在此推进，见下）
 * - 已 subscribe 且 msg.seq 为 number → updateLastSeenSeq（仅正常递进路径；gap 路径不推进基线，MF-3）
 * - 未 subscribe（state 不存在或 subscribed=false）→ 不更新基线（兼容路径）
 *
 * @returns 是否继续 dispatch（false = drop，调用方直接 return）
 */
function applySeqGap(sid: string, msg: ServerMessage): boolean {
  const state = getSubscriptionState(sid)
  const decision = evalSeqGap(msg, state)
  if (decision.action === 'drop') {
    return false
  }
  if (decision.reconcileFromSeq !== undefined) {
    // gap detected：中间 seq 缺失 → 回拉缺失段（fromSeq = lastSeenSeq，排他下界覆盖全部缺失段）。
    // 不 return：当前消息仍 dispatch（gap 期间尽量不丢，reconcile 负责补齐缺失段）。
    // [MF-3] 基线不在此推进：若 reconcile 成功前把基线推进到 msg.seq，subscribe RPC 失败
    // （网络抖动/重连窗口）后缺失段永久不可恢复。推进时机由 subscribeSession 内部负责——
    // 成功后其 max() 收敛把基线推进到 max(reply.lastSeq, snapshot seqs)（>= msg.seq，不回退）；
    // 失败则基线保持原位，后续 live 消息再次触发 reconcile 形成自愈重试（无无限循环：
    // 每次新消息至多 1 次 RPC，in-flight 去重收敛并发）。
    //
    // [PR #175 review R1] gap 触发消息去重簿记：本消息即将 dispatch 但基线不推进，而
    // reconcile 的 subscribe(fromSeq=排他下界) 返回的 snapshot 必含本消息本身 → 回放时
    // 靠 gapDispatchedSeqs drop（见 seq-gap.ts 分支 4b），否则 message_start 双实体 /
    // customStart 双 system notice。
    if (typeof msg.seq === 'number') {
      recordGapDispatchedSeq(sid, msg.seq)
    }
    void subscribeSession(sid, decision.reconcileFromSeq)
    return true
  }
  if (state && state.subscribed && typeof msg.seq === 'number') {
    // 正常递进（seq === lastSeenSeq+1）：更新基线 + 继续 dispatch。
    updateLastSeenSeq(sid, msg.seq)
  }
  return true
}

/**
 * ROUTE_TABLE —— 精确 type 匹配条目表（DM3，TC1；Q1-4：Record 直查 O(1)）。
 *
 * 收编 effect 类 type（session.exited / message.complete / session.subagents /
 * session.workflowUpdate / error-with-sid）：
 * remote-use 的 busy/idle/presence/deleting/deleted 分支未迁入（feat-remote-use 未合并），
 * 由 connection-lifecycle slice 承接（届时作为新条目追加，不修改路由核心）。
 *
 * [Q1-4] 从数组 `.find(e => e.type === msg.type)` 线性扫描改为 Record 下标直查。
 * 行为等价性守卫：查表必须经 hasOwnProperty.call 判定自有键——裸 `ROUTE_TABLE[msg.type]`
 * 在 type 为 'constructor'/'toString' 等原型成员名时会命中 Object 原型（truthy 但
 * .handle 为 undefined → TypeError），原 .find 语义只匹配自有 type 字段。
 */
const ROUTE_TABLE: Record<string, RouteTableEntry> = {
  'session.exited': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return // 无 sid 由 FALLBACK 处理（不会走到这里，防御）
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // session.exited 兜底：进程退出必须标记 dead + toast，不能只依赖惰性的 session
      // 通道订阅（首次 send 前可能无订阅者 → dispatchSession no-op → 错误丢弃）。
      effects.onSessionExited?.(sid, msg.payload as { code: number | null; reason: string })
    },
  },
  'message.complete': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // message.complete：后台完成时提示音 + 未读标记（renderer 注册回调内实现）。
      effects.onMessageComplete?.(sid, msg.payload as { sessionId?: string; stopReason?: string })
    },
  },
  'session.subagents': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // session.subagents 兜底：subagent 终态推送必须在所有 session 生效（含非活跃），
      // 不能只依赖 per-focus 订阅（切走即退订 → 终态丢弃 → 侧栏卡 running）。
      const payload = msg.payload as { subagents?: SubagentRecord[] }
      if (Array.isArray(payload.subagents)) {
        effects.onSubagents?.(sid, payload.subagents)
      }
    },
  },
  'session.subagentEntriesAppended': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // [E-4] subagent entry 帧兜底：写 chatStore 虚拟分区必须在所有 session 生效
      //（帧先于 drawer 打开——分区惰性创建不依赖订阅，§6.1）。payload 守卫对齐
      // session.subagents 条目（subagentId 非空 + entries 数组，坏形状跳过 effect 但
      // dispatch 照常——per-session 订阅者可能自带消费逻辑）。
      const payload = msg.payload as { subagentId?: unknown; entries?: unknown }
      if (typeof payload.subagentId !== 'string' || payload.subagentId === '') return
      if (!Array.isArray(payload.entries)) return
      effects.onSubagentEntries?.(
        sid,
        payload.subagentId,
        payload.entries as Array<PiEntry | PiToolCallEntryForm>,
      )
    },
  },
  'session.workflowUpdate': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // session.workflowUpdate 兜底：workflow 增量信号触发 loadWorkflows + running 延迟重试，
      // 同样在所有 session（含非活跃）生效，不依赖 per-focus 订阅。
      // payload 锚定 protocol SSOT（ServerMessageMap['session.workflowUpdate']，MF-4）：
      // update.status/runId 必填，runtime 改形状时此处编译报错，不再静默收 undefined。
      const payload = msg.payload as ServerMessageMap['session.workflowUpdate']
      effects.onWorkflowUpdate?.(sid, payload.update)
    },
  },
  'error': {
    handle(msg, { ports, effects, sid }) {
      if (!sid) return // 无 sid 的 error 由 FALLBACK 的全局兜底处理（onGlobalError → toast）
      // error envelope 无 seq（broker.send 直发，非 bus.publish live 帧）→ evalSeqGap 分支 3
      // 正常放行，不触发 gap reconcile
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // D6b：带 sid 的 error envelope 兜底（见 InboundEffects.onSessionError 注释）。
      // payload.message 缺失时兜底通用文案，防御运行时坏形状。
      const payload = msg.payload as { code?: string; message?: string }
      effects.onSessionError?.(sid, {
        code: payload.code,
        message: typeof payload.message === 'string' ? payload.message : 'Unknown error',
      })
    },
  },
}

/**
 * CROSS_SESSION_TYPES —— 带 sid 但需同时分发到全局消费者的消息 type 白名单（ADR-0060 决策1）。
 *
 * 这些 type 虽带 sessionId（走 session 通道），但 ExtensionHost 是全局单例消费者
 * （ViewHostStore 按 per-session Map 分区，需收所有 session 的下行，不随 session 切换退订），
 * 故 FALLBACK 有 sid 分支在 dispatchSession 后额外 dispatchCrossSession。
 *
 * type 分隔符与 runtime wire 实际格式一致（shared/protocol.ts ServerMessageType）：
 * extension:widget/widgetGui/status/notify 用冒号；extension.ui_request 用**点号**
 * （runtime event-adapter.ts 实发 'extension.ui_request'，ADR-0060 文档里的冒号为笔误，
 * 以 protocol.ts + MessageBusBridge EXTENSION_HANDLERS 为准）。
 *
 * 不进 ROUTE_TABLE：它们不需 InboundEffects 兜底（无 effect 回调），与现有条目结构不同
 * （只需 dispatchSession + dispatchCrossSession），硬塞会产出雷同 handle 函数。
 */
const CROSS_SESSION_TYPES = new Set([
  'extension:widget',
  'extension:widgetGui',
  'extension:status',
  'extension:notify',
  'extension.ui_request', // 点号：runtime wire 实际格式（见上方注释）
  'extension.ui_timeout', // 带 sid 的 ui 超时广播：DialogRequestQueue onUiTimeout 经 crossSession 通道订阅（MF-6）
  // plugin:* 带 sid 下行（runtime 广播注入 sessionId）：ExtensionHost 全局单例消费者需同时收
  // session 通道 + crossSession 通道（ViewHostStore / DialogRequestQueue 按 per-session 分区）
  'plugin:uiRequest',
  'plugin:viewUpdate',
])

/**
 * FALLBACK —— 恒真兜底条目（DM3，TC1）。
 *
 * 等价现状行为：有 sid → seq gap + dispatchSession；无 sid → dispatchGlobal + L9 warn +
 * onGlobalError。未注册的新 type 自动落入现状语义，零行为回归。
 *
 * ADR-0060 增量：有 sid 且 type ∈ CROSS_SESSION_TYPES 时，dispatchSession 后额外
 * dispatchCrossSession（在 applySeqGap 之后——seq gap drop 的重复消息 crossSession 也不发，
 * 防 ExtensionHost 重复处理，与 session 通道 drop 语义一致）。
 */
const FALLBACK: RouteTableEntry['handle'] = (msg, { ports, effects, sid }) => {
  if (typeof sid === 'string' && sid) {
    if (!applySeqGap(sid, msg)) return
    ports.events.dispatchSession(sid, msg)
    // ADR-0060：带 sid 的 extension:* 下行同时分发到全局消费者（ExtensionHost 单例）。
    if (CROSS_SESSION_TYPES.has(msg.type)) {
      ports.events.dispatchCrossSession(msg)
    }
    // [idle-refresh] subagent.stream_delta 桥接（§5.1 D1）：该 type 不在 ROUTE_TABLE /
    // CROSS_SESSION_TYPES（唯一关切是活跃信号，无需独立路由条目），恒落 FALLBACK——
    // 此处按 type 识别后透传原始 frame，父 sid 解析与 refreshStreamingTimer 调用由
    // effects 实现方完成（见 InboundEffects.onSubagentStreamDelta 注释）。非本 type
    // 帧不调用（no-op）；未注册回调时跳过（生产接线前行为与现状一致）。
    if (msg.type === 'subagent.stream_delta') {
      effects.onSubagentStreamDelta?.(msg)
    }
    return
  }
  ports.events.dispatchGlobal(msg)
  // L9：session 级消息（type 以 session./message. 开头）缺失 sessionId 时 warn，
  // 让 runtime bug 可见（违反隔离要求应有 fail-fast 信号，而非静默降级到 global 丢弃）
  if (msg.type.startsWith('session.') || msg.type.startsWith('message.')) {
    console.warn('[core/coordination] session-level message missing sessionId, routed to global:', msg.type)
  }
  // 全局 error 兜底：无 sessionId、无 id 的 server-push error 此前静默丢弃。
  // 现 toast 提示（如 config 加载失败等全局错误）——renderer 注册 onGlobalError 实现 toast。
  if (msg.type === 'error' && !msg.id) {
    const payload = msg.payload as { message?: string }
    const message = typeof payload.message === 'string' ? payload.message : 'Unknown error'
    effects.onGlobalError?.(message)
  }
}

// ── configureRouteInbound（IF4） ───────────────────────────────────

/**
 * 构造并返回入站 dispatcher（IF4）。
 *
 * 一次性注入三件套（pending/events/subscribe）+ 可选 effects（TC2/TC3）：
 * - setSubscriptionPorts 注入 subscribe RPC + replay 回放 dispatcher（C1，PR #175 review R1）
 * - 幂等由调用方 ensureDispatcher 保证（renderer 侧只安装一次）
 *
 * 处理顺序（live dispatcher）：
 *   1. msg.id 命中 pending → resolveEnvelope 委托 pending 层（error envelope 展开 code+details
 *      到 Error，收尾 6 R2/ES1），return 不再进路由表（id/seq 来源互斥 D7）
 *   2. 查 ROUTE_TABLE 精确 type 条目 → seq gap 中间件 + dispatchSession + effect 回调
 *   3. 恒真 FALLBACK：有 sessionId → seq gap + dispatchSession；无 → dispatchGlobal + L9 warn
 *      + error 无 id → onGlobalError
 *
 * 步骤 2+3 抽成共享核心 dispatchRouted——subscription-state 的 snapshot/stateSnapshot
 * 回放经注入的 replay 走同一条路径（sid 固定为 subscribe 目标，跳过步骤 1 的 pending
 * 分流：回放消息来自 bus ring 广播而非 RPC reply），使回放与 live 共享 seq 去重 +
 * effects + crossSession 语义。此前回放裸调 events.dispatchSession 绕过全部三样，导致
 * gap 触发消息重复实体 + 回放帧不触发 subagent 终态兜底（PR #175 review R1 MUST_FIX）。
 *
 * @param ports renderer 注入的 WS 能力（必填三件套）
 * @param effects 可选 effect 回调集（undefined 跳过）
 * @returns 入站消息 dispatcher：dispatcher(msg: ServerMessage)
 */
export function configureRouteInbound(
  ports: TransportPorts,
  effects?: InboundEffects,
): (msg: ServerMessage) => void {
  const ctx: RouteContext = { ports, effects: effects ?? {} }

  // 共享路由核心（步骤 2+3）：live 与回放同一条路径，行为差异只在 sid 来源与 pending 分流。
  function dispatchRouted(msg: ServerMessage, sid: string | undefined): void {
    if (typeof sid === 'string' && sid) {
      // [Q1-4] Record 直查（O(1)）。hasOwnProperty.call 守卫原型成员名（'constructor' 等），
      // 语义与旧数组 .find 严格等价（只匹配自有 type 键）。不用 Object.hasOwn：renderer
      // vue-tsc 的 lib 不含 ES2022（TS2550）。
      const entry = Object.prototype.hasOwnProperty.call(ROUTE_TABLE, msg.type)
        ? ROUTE_TABLE[msg.type]
        : undefined
      if (entry) {
        entry.handle(msg, { ...ctx, sid })
        return
      }
    }
    FALLBACK(msg, { ...ctx, sid })
  }

  // 回放 dispatcher：subscription-state 的 subscribeSession 回放入口（C1 注入）。
  // 与 live dispatcher 的差异仅两点（见上方注释），其余（seq gap 去重 + ROUTE_TABLE
  // effects + crossSession 分发）完全共享。
  setSubscriptionPorts({
    subscribe: ports.subscribe,
    replay: (sid, msg) => dispatchRouted(msg, sid),
  })

  return function routeInbound(msg: ServerMessage): void {
    // ── 1. pending 分流（D7：id/seq 互斥，命中 pending 的 RPC reply 不进路由表） ──
    // [HISTORICAL] 必须用 ports.pending.has(msg.id) 收紧判定，不能只看 msg.id 是否存在：
    // runtime 的 broadcast（config.skills/agents/providers/dirs/defaults 等）也携带 nextPushId
    // 作为 id（message-broker.buildXxxMsg 给所有广播加 `id: nextPushId()`）。若只凭 msg.id
    // 存在就判为 reply，广播会被 pending 分流吞掉（pendingMap 无 push_* 条目 → resolve/reject
    // 静默 no-op），消息不进 ROUTE_TABLE/FALLBACK → dispatchGlobal 永不调用 → 靠广播推送的
    // settingsStore.skills/agents（无 refresh RPC 兜底，区别于有 refresh 的 providers/models）
    // 永空。2026-08 审查报告 R5 问题 9 根因。
    if (msg.id && ports.pending.has(msg.id)) {
      // envelope 展开（code 提取 + details.detail → Error）委托 pending 层（收尾 6，R2/ES1），
      // 实现见 renderer api/pending.ts resolveEnvelope。行为与内联版零差异。
      ports.pending.resolveEnvelope(msg)
      return // D7：pending 分流后不再进路由表
    }

    // payload 跨多种 type：有的含 sessionId（session 通道），有的不含（global 通道）。
    // 联合类型无法直接 .sessionId，窄断言为可选字段做路由判定（隔离规则不变）。
    const sid = (msg.payload as { sessionId?: string }).sessionId
    dispatchRouted(msg, sid)
  }
}
