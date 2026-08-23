/**
 * SessionDeliveryRegistry — runtime 侧的 delivery 内核装配 + sessionId 单例注册表。
 *
 * sd-u5（session-manager send 排队）的 runtime 适配器（design.md §3.1 调用方 B）：
 * - payload 能力仅 'text'（runtime 通路拿不到 pi custom message，D9）
 * - isIdle 读 runtime 状态标志（isGenerating / isCompacting / isBashRunning 三者互斥判定）
 * - hasPendingMessages 一期保守 false（端口同步签名拿不到异步 RPC 结果，design.md §5 待验证 1）
 * - subscribeSettled 经组合根 onAgentSettled 多播（index.ts agentSettledListeners）
 * - port.send：ensureActive → prompt(streamingBehavior) → 成功后置位 + record（D7 保留副作用）
 *
 * 单例约束（§3.4）：同 sessionId 必须复用同一 handle——多 handle 并发投递竞态无保护。
 * sd-u6（完成回流）将复用本注册表，禁止自行 createDelivery。
 */
import { createDelivery } from '@xyz-agent/session-delivery'
import type { DeliveryHandle } from '@xyz-agent/session-delivery'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'

/** 组合根注入的装配材料（全部窄签名，测试可 mock） */
export interface SessionDeliveryDeps {
  /** 读 session 运行时状态标志（isIdle 判定 + D7 置位副作用） */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** pi 死则 restore 拉起（D7 保留：投递可达性前提） */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** agent_settled 多播订阅（组合根 agentSettledListeners；返回退订函数） */
  subscribeAgentSettled(cb: (sessionId: string) => void): () => void
  /** 最近工作区记账（D7 保留：best-effort，调用方不感知失败） */
  recordWorkspace(cwd: string): void
}

/** 注册表对外接口（SessionManagerHandler 经此消费 delivery 能力） */
export interface SessionDeliveryRegistry {
  /** 同 sessionId 复用同一 handle（单例约束）；factory 仅供测试注入替身 */
  getOrCreateDelivery(sessionId: string, factory?: (sessionId: string) => DeliveryHandle): DeliveryHandle
  /** port 同款直投（handleCreate 初始 prompt：新 session 必 idle 无竞态，不走内核队列，失败照旧 throw） */
  sendDirect(sessionId: string, content: string): Promise<void>
  /** 丢弃单 session 队列（session 删除等场景） */
  dispose(sessionId: string): void
  disposeAll(): void
}

/**
 * intent → pi streamingBehavior 的映射表（D3：pi 词汇封闭在适配器内）。
 * streamingBehavior 同时是 runtime 通路的安全网——isIdle 读的是 runtime 侧状态标志，
 * 与 pi 实际 isStreaming 存在 TOCTOU；竞态命中时由 pi 队列兜底（不抛错）。
 */
function toStreamingBehavior(intent: 'interrupt-at-turn-boundary' | 'after-run'): 'steer' | 'followUp' {
  return intent === 'interrupt-at-turn-boundary' ? 'steer' : 'followUp'
}

export function createSessionDeliveryRegistry(deps: SessionDeliveryDeps): SessionDeliveryRegistry {
  const handles = new Map<string, DeliveryHandle>()

  /**
   * port 层投递原语：ensureActive → prompt → D7 置位副作用。
   * 置位晚于 prompt 受理（成功才显示 working，与 dispatcher「先置位后 prompt」的差异是
   * 内核 gate 语义的要求：置位晚于 gate 判定不构成矛盾——gate 只在投递前判）。
   */
  const deliverText = async (
    sessionId: string,
    content: string,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<void> => {
    const client = await deps.ensureActive(sessionId)
    await client.prompt(content, undefined, streamingBehavior)
    // D7 保留副作用：prompt 受理成功后一并置位（侧栏 working 显示 + lastActiveAt 排序新鲜度）
    const session = deps.getSession(sessionId)
    if (session) {
      session.lastActiveAt = Date.now()
      session.isGenerating = true
      try {
        deps.recordWorkspace(session.cwd)
      } catch (e) {
        // D7 保留：best-effort，失败仅 warn 不传播（isGenerating 已置位不回退）
        console.warn('[session-delivery] workspace.record failed (non-blocking), sid=', sessionId, e)
      }
    }
  }

  const buildHandle = (sessionId: string): DeliveryHandle =>
    createDelivery(
      {
        supportedPayloads: ['text'],
        isIdle: () => {
          const s = deps.getSession(sessionId)
          return !!s && !s.isGenerating && !s.isCompacting && !s.isBashRunning
        },
        // 一期保守（design.md §5 待验证 1）：同步签名拿不到 get_state 的 pendingMessageCount
        hasPendingMessages: () => false,
        subscribeSettled: (cb) =>
          deps.subscribeAgentSettled((sid) => {
            if (sid === sessionId) cb()
          }),
        send: (msg, intent) => {
          if (msg.payload.kind !== 'text') {
            // 内核已按 supportedPayloads fail-fast，此为防御性双保险（不静默忽略）
            throw new Error(`[session-delivery] unsupported payload kind: ${msg.payload.kind}`)
          }
          return deliverText(sessionId, msg.payload.content, toStreamingBehavior(intent))
        },
      },
      // 默认意图：turn 边界抢占（D3，F1 教训内化）
      { intent: 'interrupt-at-turn-boundary' },
    )

  return {
    getOrCreateDelivery(sessionId, factory) {
      const existing = handles.get(sessionId)
      if (existing) return existing
      const handle = factory ? factory(sessionId) : buildHandle(sessionId)
      handles.set(sessionId, handle)
      return handle
    },
    sendDirect(sessionId, content) {
      // create 初始 prompt：新 session 必 idle，不传 streamingBehavior（无竞态窗口）
      return deliverText(sessionId, content)
    },
    dispose(sessionId) {
      handles.get(sessionId)?.dispose()
      handles.delete(sessionId)
    },
    disposeAll() {
      for (const handle of handles.values()) handle.dispose()
      handles.clear()
    },
  }
}
