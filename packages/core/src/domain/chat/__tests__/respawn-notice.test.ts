/**
 * u8-pi-respawn core 消费链测试（crash-resilience §3.3 D7）：
 * ① route-inbound 的 session.restored / session.restoreFailed 条目 → InboundEffects 回调
 *   （session.exited 兜底同款契约：dispatchSession 后触发、payload 透传）；
 * ② chat store appendRespawnNotice：提示条消息形态（customType = PI_RESPAWN_NOTICE_CUSTOM_TYPE、
 *   details.variant、liveOnly、display:true、fallback 文本入 content）。
 *
 * 两个消费面共置一文件（同一 u8 消费链，且避免与并行单元同文件冲突）。纯内存，不触 fs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { configureRouteInbound } from '../../../coordination/route-inbound'
import type { TransportPorts, InboundEffects } from '../../../coordination/route-inbound'
import { resetSubscriptionStates } from '../../../coordination/subscription-state'
import { PI_RESPAWN_NOTICE_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { ServerMessage } from '@xyz-agent/shared'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'

function makePorts(): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
    },
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0, gap: false }),
  }
}

function sessionMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], payload: { sessionId: 's1', ...payload } } as ServerMessage
}

describe('route-inbound：session.restored / session.restoreFailed 条目（u8 D7）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('session.restored → onSessionRestored 回调（sid + payload 透传），dispatchSession 照常', () => {
    const ports = makePorts()
    const effects: InboundEffects = {
      onSessionRestored: vi.fn(),
    }
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.restored', { attempts: 1 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionRestored).toHaveBeenCalledWith('s1', { sessionId: 's1', attempts: 1 })
  })

  it('session.restoreFailed → onSessionRestoreFailed 回调（willRetry/reason 透传）', () => {
    const ports = makePorts()
    const effects: InboundEffects = {
      onSessionRestoreFailed: vi.fn(),
    }
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.restoreFailed', { attempts: 2, willRetry: false, reason: 'attach hard-fail' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionRestoreFailed).toHaveBeenCalledWith('s1', {
      sessionId: 's1',
      attempts: 2,
      willRetry: false,
      reason: 'attach hard-fail',
    })
  })

  it('未注册 effects 时条目无害（分发照常、无回调）', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    expect(() => dispatcher(sessionMsg('session.restored', { attempts: 1 }))).not.toThrow()
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
  })
})

describe('chat store appendRespawnNotice（u8 提示条写入点）', () => {
  /** store 实例（effectScope 包裹 onScopeDispose 注册，store.test.ts makeStore 同款） */
  let store: ChatStoreInstance
  let dispose: () => void

  beforeEach(() => {
    const scope = effectScope(true)
    store = scope.run(() => createChatStore())!
    dispose = () => scope.stop()
  })

  afterEach(() => {
    dispose()
  })

  it('restored 形态：customType/variant/liveOnly/display/fallback 文本齐备，追加到消息流', () => {
    store.appendRespawnNotice('s1', 'restored', 'fallback restored text')
    const messages = store.getMessages('s1')
    expect(messages).toHaveLength(1)
    const notice = messages[0]
    expect(notice.role).toBe('system')
    expect(notice.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(notice.details).toEqual({ variant: 'restored' })
    expect(notice.liveOnly).toBe(true)
    expect(notice.display).toBe(true)
    expect(notice.content).toBe('fallback restored text')
    expect(notice.status).toBe('complete')
    expect(notice.id.startsWith('sys-')).toBe(true)
  })

  it('restoreFailed 形态：variant 透传（渲染方据此切失败态 + 重试按钮）', () => {
    store.appendRespawnNotice('s1', 'restoreFailed', 'fallback failed text')
    const notice = store.getMessages('s1')[0]
    expect(notice.details).toEqual({ variant: 'restoreFailed' })
    expect(notice.content).toBe('fallback failed text')
  })

  it('追加不覆盖既有消息（append 语义，与 appendSystemNotice 同款）', () => {
    store.appendRespawnNotice('s1', 'restored', 'first')
    store.appendRespawnNotice('s1', 'restoreFailed', 'second')
    const messages = store.getMessages('s1')
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('second')
  })
})
