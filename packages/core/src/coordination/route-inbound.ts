/**
 * route-inbound —— 入站消息分发器（迁移自 renderer useConnection.ts routeInbound，IF1/IF2/IF4 + DM3）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolve（普通响应）/ reject（error envelope，ES1）→ return（D7）
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
 *   - seq > lastSeenSeq+1 → 触发 subscribeSession(sid, seq-1) reconcile（ES2 失败兜底），
 *     当前 msg 仍 dispatch
 *   - seq === lastSeenSeq+1 → 正常递进，dispatch + 更新 lastSeenSeq
 * 未 subscribe 的 session（state 不存在或 subscribed=false）不做 gap 检测，正常 dispatch
 * （渐进迁移，remove-bandaids wave 统一）。pending 路径（msg.id 分支）不受 seq 影响——
 * id/seq 来源互斥（D7）。
 *
 * core 零 import renderer：renderer 的 WS 能力（pending/events/subscribe）经 TransportPorts
 * 注入（TC2/TC3 一次性注入三件套），effect 兜底经 InboundEffects 注入（undefined 跳过）。
 */
import type { ServerMessage, SubagentRecord } from '@xyz-agent/shared'
import { evalSeqGap } from './seq-gap'
import {
  getSubscriptionState,
  subscribeSession,
  updateLastSeenSeq,
  setSubscriptionPorts,
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
  }
  events: {
    dispatchSession(sessionId: string, msg: ServerMessage): void
    dispatchGlobal(msg: ServerMessage): void
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
  onWorkflowUpdate?(sessionId: string, update: { status?: string }): void
  onGlobalError?(message: string): void
}

// ── ROUTE_TABLE（DM3） ─────────────────────────────────────────────

/**
 * 路由表条目：精确 type 字符串匹配（TC1）。
 *
 * handle 内部：seq gap 中间件（session 通道）→ dispatchSession → effect 回调。
 * 表内条目顺序无依赖（type 互斥，精确匹配同一消息只命中一条）。
 */
type RouteTableEntry = {
  type: string
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
 * - pass 带 reconcileFromSeq → void fire-and-forget subscribeSession(sid, seq-1) 回拉缺失段
 *   （失败由 subscribeSession 内部 console.warn 消化，ES2）
 * - 已 subscribe 且 msg.seq 为 number → updateLastSeenSeq（正常递进与 gap 后当前消息均更新）
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
    // gap detected：中间 seq 缺失 → 回拉缺失段（fromSeq = seq-1）。
    // 不 return：当前消息仍 dispatch（gap 期间尽量不丢，reconcile 负责补齐缺失段）。
    void subscribeSession(sid, decision.reconcileFromSeq)
  }
  if (state && state.subscribed && typeof msg.seq === 'number') {
    // 正常递进（seq === lastSeenSeq+1）或 gap 后当前消息：更新基线 + 继续 dispatch。
    updateLastSeenSeq(sid, msg.seq)
  }
  return true
}

/**
 * ROUTE_TABLE —— 精确 type 匹配条目数组（DM3，TC1）。
 *
 * 只收编现状 4 个 effect 类 type（slice design-review sufficiency gaps）：
 * remote-use 的 busy/idle/presence/deleting/deleted 分支未迁入（feat-remote-use 未合并），
 * 由 connection-lifecycle slice 承接（届时作为新条目追加，不修改路由核心）。
 */
const ROUTE_TABLE: RouteTableEntry[] = [
  {
    type: 'session.exited',
    handle(msg, { ports, effects, sid }) {
      if (!sid) return // 无 sid 由 FALLBACK 处理（不会走到这里，防御）
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // session.exited 兜底：进程退出必须标记 dead + toast，不能只依赖惰性的 session
      // 通道订阅（首次 send 前可能无订阅者 → dispatchSession no-op → 错误丢弃）。
      effects.onSessionExited?.(sid, msg.payload as { code: number | null; reason: string })
    },
  },
  {
    type: 'message.complete',
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // message.complete：后台完成时提示音 + 未读标记（renderer 注册回调内实现）。
      effects.onMessageComplete?.(sid, msg.payload as { sessionId?: string; stopReason?: string })
    },
  },
  {
    type: 'session.subagents',
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
  {
    type: 'session.workflowUpdate',
    handle(msg, { ports, effects, sid }) {
      if (!sid) return
      if (!applySeqGap(sid, msg)) return
      ports.events.dispatchSession(sid, msg)
      // session.workflowUpdate 兜底：workflow 增量信号触发 loadWorkflows + running 延迟重试，
      // 同样在所有 session（含非活跃）生效，不依赖 per-focus 订阅。
      const payload = msg.payload as { update?: { status?: string } }
      effects.onWorkflowUpdate?.(sid, payload.update ?? {})
    },
  },
]

/**
 * FALLBACK —— 恒真兜底条目（DM3，TC1）。
 *
 * 等价现状行为：有 sid → seq gap + dispatchSession；无 sid → dispatchGlobal + L9 warn +
 * onGlobalError。未注册的新 type 自动落入现状语义，零行为回归。
 */
const FALLBACK: RouteTableEntry['handle'] = (msg, { ports, effects, sid }) => {
  if (typeof sid === 'string' && sid) {
    if (!applySeqGap(sid, msg)) return
    ports.events.dispatchSession(sid, msg)
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
 * - setSubscriptionPorts(ports) 把 subscribe/events 注入 subscription-state（C1）
 * - 幂等由调用方 ensureDispatcher 保证（renderer 侧只安装一次）
 *
 * 处理顺序：
 *   1. msg.id 非空 → pending 分流（error envelope 展开 code+details 到 Error，行为等价现状
 *      R2 注释保留；非 error → resolve(id, payload)），return 不再进路由表（id/seq 来源互斥 D7）
 *   2. 查 ROUTE_TABLE 精确 type 条目 → seq gap 中间件 + dispatchSession + effect 回调
 *   3. 恒真 FALLBACK：有 sessionId → seq gap + dispatchSession；无 → dispatchGlobal + L9 warn
 *      + error 无 id → onGlobalError
 *
 * @param ports renderer 注入的 WS 能力（必填三件套）
 * @param effects 可选 effect 回调集（undefined 跳过）
 * @returns 入站消息 dispatcher：dispatcher(msg: ServerMessage)
 */
export function configureRouteInbound(
  ports: TransportPorts,
  effects?: InboundEffects,
): (msg: ServerMessage) => void {
  setSubscriptionPorts(ports)

  const ctx: RouteContext = { ports, effects: effects ?? {} }

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
      if (msg.type === 'error') {
        // type==='error' 已窄化 payload 为 error envelope（含 code + message + 可选 details）。
        // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
        // 如 out_of_cwd / permission_denied / timeout）。此前只透传 message 丢了 code。
        // R2：details.detail 展开到 reject 的 Error 上——
        // - worktree handler 把 WORKTREE_EXISTS 的 { cwd, dirName } 放 detail（对象，S5 后）；
        // - 把 SETUP_FAILED/GIT_FAILED 的 { exitCode, stderr } 放 detail。
        // 不展开则 CreateWorktreeModal error 态读不到 stderr、exists 态「直接开始」读不到 cwd。
        // 注：object 分支 Object.assign(enriched, d) 会把 cwd 和 dirName 都赋到 Error 上，
        // lastError.cwd 仍可读（onUseExisting 用），dirName 可用于前端核对是否同分支名碰撞。
        const payload = msg.payload as {
          code?: string
          message?: string
          details?: { detail?: unknown }
        }
        const message = typeof payload.message === 'string' ? payload.message : 'request failed'
        const code = typeof payload.code === 'string' ? payload.code : 'unknown'
        const enriched: Record<string, unknown> = { code }
        const d = payload.details?.detail
        if (typeof d === 'string') {
          // 字符串 detail（如 WORKTREE_EXISTS 的 cwd）直接作 cwd 字段
          enriched.cwd = d
        } else if (d && typeof d === 'object') {
          // 对象 detail（如 { exitCode, stderr }）展开到 Error 上
          Object.assign(enriched, d)
        }
        ports.pending.reject(msg.id, Object.assign(new Error(message), enriched))
      } else {
        ports.pending.resolve(msg.id, msg.payload)
      }
      return // D7：pending 分流后不再进路由表
    }

    // payload 跨多种 type：有的含 sessionId（session 通道），有的不含（global 通道）。
    // 联合类型无法直接 .sessionId，窄断言为可选字段做路由判定（隔离规则不变）。
    const sid = (msg.payload as { sessionId?: string }).sessionId

    // ── 2. ROUTE_TABLE 精确 type 匹配（TC1，仅 session 通道；无 sid 直接落 FALLBACK） ──
    if (typeof sid === 'string' && sid) {
      const entry = ROUTE_TABLE.find((e) => e.type === msg.type)
      if (entry) {
        entry.handle(msg, { ...ctx, sid })
        return
      }
    }

    // ── 3. 恒真 fallback（未注册 type / 无 sid 消息落现状语义） ──
    FALLBACK(msg, { ...ctx, sid })
  }
}
