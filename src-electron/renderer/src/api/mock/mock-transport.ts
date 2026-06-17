import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { Transport } from '../transport'
import { getMockResponse } from './responses'

/**
 * 不走真实 ws 的 Transport 实现（SA3 / D8）：
 * send 时按 type 查 mock 响应表，回灌预制 ServerMessage。
 *
 * - 命令响应：回填请求 id（responses.ts 的 reply() 已处理）→ pending 结算。
 * - 事件：无 id → events 路径。
 * - message.send 的流式：首条（message.status 带 id，命令响应）立即发，其余 setTimeout 链发，
 *   模拟真实打字机效果；测试用 fake timers 推进。
 *
 * 选 A 装配（不碰 ws-client 的 isMock 分支）：mock transport 独立工作，
 * ws-client 的 mockConnect 仅驱动 UI 连接状态显示，二者互不依赖。
 */
// ponytail: 50ms 流式步进，够快不阻塞、又保留了打字机观感；要更真实可调到 300
const STREAM_STEP_MS = 50

export function createMockTransport(): Transport {
  const messageHandlers = new Set<(msg: ServerMessage) => void>()
  const closeHandlers = new Set<(reason: string) => void>()

  const emit = (msg: ServerMessage): void => {
    messageHandlers.forEach((h) => {
      try {
        h(msg)
      // eslint-disable-next-line taste/no-silent-catch -- 一个 handler 挂不能阻断其他（events 同款语义）
      } catch (e) {
        console.error('[mock-transport] handler error:', e)
      }
    })
  }

  return {
    send(msg: ClientMessage): void {
      const responses = getMockResponse(msg)
      if (responses.length === 0) return

      if (msg.type === 'message.send') {
        // 首条立即（message.status 带 id → pending 结算），其余延迟发模拟流式
        emit(responses[0])
        let delay = 0
        for (let i = 1; i < responses.length; i++) {
          delay += STREAM_STEP_MS
          const m = responses[i]
          setTimeout(() => emit(m), delay)
        }
        return
      }

      // 其余命令：同步全发（compact 的 compacted 紧随 compacting，无延迟观感损失）
      for (const r of responses) emit(r)
    },

    onMessage(handler: (msg: ServerMessage) => void): () => void {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },

    onClose(handler: (reason: string) => void): () => void {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
  }
}
