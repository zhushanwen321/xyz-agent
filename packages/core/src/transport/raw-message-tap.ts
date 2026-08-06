/**
 * raw-message-tap —— 原始消息 tap（routeInbound 之前的只读旁路）。
 *
 * 背景：ExtensionHost 的消息源（renderer createWsPluginMessageSource）需要拿到所有下行
 * ServerMessage，但 routeInbound（coordination/route-inbound.ts）用 payload.sessionId 路由：
 * 有 sessionId 的消息（如 extension:notify/widget/status/ui_request）走 dispatchSession，
 * 不触发 onGlobal。pi extension 的 per-session 下行因此收不到，bus handler 永不触发。
 *
 * 解决方案：在 transport 层加一条只读旁路——每条消息进 routeInbound 前先过 tap，
 * ExtensionHost source 从 tap 订阅（不分 global/session 通道），替代 onGlobal。
 *
 * 设计约束：
 * - 只读旁路：emit 在 dispatcher（routeInbound）之前；handler 抛错 try-catch 隔离，
 *   绝不阻断 routeInbound 主流程。
 * - 同步执行：与 onGlobal（events.ts dispatchGlobal 同步 safeForEach）一致。
 * - core headless：本文件零 DOM / 零 electron / 零浏览器 API，仅依赖 shared 类型。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/** 原始消息 tap 实例（routeInbound 之前的只读旁路）。ExtensionHost source 用它拿不分通道的消息流。 */
export interface RawMessageTap {
  subscribe(handler: (msg: ServerMessage) => void): () => void
  emit(msg: ServerMessage): void
}

/** 创建一个 raw message tap 实例（非单例，调用方自行管理生命周期）。 */
export function createRawMessageTap(): RawMessageTap {
  const handlers = new Set<(msg: ServerMessage) => void>()
  return {
    subscribe(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(msg) {
      // tap 是只读旁路：单个 handler 抛错不得阻断其他 handler 或主 dispatcher 流程
      for (const h of handlers) {
        try {
          h(msg)
        // eslint-disable-next-line taste/no-silent-catch -- 旁路隔离：handler 抛错仅记录，绝不阻断其余 handler 或主 dispatcher（与 events.ts safeForEach 同语义）
        } catch (e) {
          console.warn('[raw-message-tap] handler error', e)
        }
      }
    },
  }
}

/**
 * 模块级共享 tap 单例（IF1 语义，与 getExtensionBus 同模式）：惰性单例。
 *
 * source（renderer useExtensionHostBridge 的 createWsPluginMessageSource）与 use-connection
 * （core ensureDispatcher / installDispatcher）共享同一实例——source subscribe、use-connection emit。
 * 时序无关（单例惰性创建）：无论哪方先调用都拿到同一实例，跨 core/renderer 包边界共享。
 */
let sharedTap: RawMessageTap | null = null
export function getRawMessageTap(): RawMessageTap {
  if (!sharedTap) sharedTap = createRawMessageTap()
  return sharedTap
}
