/**
 * ws-client.send 返回布尔值回归测试（W4 fast-fail）—— shim→core 链路版。
 *
 * 锁定 W4 改动：send(msg) 应返回 boolean，让调用方能在连接未就绪时 fast-fail
 * （如 pending.send 在 connecting / closed 态立即 reject，而非默默丢弃消息
 * 让 Promise 永挂，直到超时才报错）。
 *
 * ── W2 迁移后重写说明 ──
 * 旧版依赖 renderer ws-client 内部 isMock 分支调 mockSend 控制返回值。W2 把 ws-client
 * 迁入 core（re-export shim），mock 行为改由 platform 注入，旧 isMock 分支已删除。
 * 本测试改为：注入可控 readyState 的 fake-WS platform（providePlatform），经
 * @/lib/ws-client（shim）→ core 的 connect/disconnect/send 验证布尔契约。
 *
 * W4 fast-fail 契约的主覆盖在 core invariants.test.ts:270（OPEN→true / 非 OPEN→false），
 * renderer 侧重在验证 shim 转发链路不断（catch shim export 名拼写错 / 转发断链）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/ws-client-send-boolean.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ClientMessage } from '@xyz-agent/shared'
import { connect, disconnect, send } from '@/lib/ws-client'
import {
  providePlatform,
  WS_READY_STATE,
  type PlatformPort,
  type WebSocketLike,
} from '@xyz-agent/core'

// ── 可控 fake-WS platform：readyState + onopen/onmessage 句柄由测试持有 ──
function makeFakePlatform(initialReadyState: number = WS_READY_STATE.CONNECTING) {
  let readyState = initialReadyState
  const sent: string[] = []
  const ws: WebSocketLike = {
    get readyState() {
      return readyState
    },
    send: (data: string) => {
      sent.push(data)
    },
    close: () => {
      readyState = WS_READY_STATE.CLOSED
    },
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  }
  const platform: PlatformPort = {
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: { create: () => ws },
    ipc: null,
  }
  return {
    platform,
    setReadyState: (r: number) => {
      readyState = r
    },
    triggerOpen: () => {
      readyState = WS_READY_STATE.OPEN
      ws.onopen?.()
    },
    sent,
  }
}

describe('ws-client.send 返回 boolean（W4 fast-fail，经 shim→core 链路）', () => {
  let fake: ReturnType<typeof makeFakePlatform>

  beforeEach(() => {
    vi.useFakeTimers()
    fake = makeFakePlatform()
    providePlatform(fake.platform)
  })

  afterEach(() => {
    disconnect()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('OPEN 时 send 实际发送并返回 true', () => {
    connect('ws://test')
    fake.triggerOpen() // core ws-client.onopen 设 connected + startHeartbeat
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(true)
    expect(fake.sent).toHaveLength(1)
  })

  it('CONNECTING 时 send 返回 false（fast-fail，不发送）', () => {
    connect('ws://test')
    // 不 triggerOpen，readyState 仍 CONNECTING
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(false)
    expect(fake.sent).toHaveLength(0)
  })

  it('disconnect 后 send 返回 false（ws=null，fast-fail）', () => {
    connect('ws://test')
    fake.triggerOpen()
    disconnect()
    const msg: ClientMessage = { type: 'ping', payload: {} }
    const result = send(msg)
    expect(result).toBe(false)
  })

  it('send 返回值类型为 boolean（W4 契约：非 void/undefined）', () => {
    connect('ws://test')
    fake.triggerOpen()
    const result = send({ type: 'ping', payload: {} })
    expect(typeof result).toBe('boolean')
  })
})
