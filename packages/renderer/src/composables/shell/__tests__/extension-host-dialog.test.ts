/**
 * extension-host-dialog.test.ts —— CompanionBand 适配层单测（FR2/FR7，AC2/AC6/AC9）。
 *
 * 覆盖：TC1-TC4 convertToDialogRequest 转换（source 判定 / askUser 改写 / options 归一 /
 * method 超界恢复 + receivedAt）；TC5 无 sessionId 跳过；TC6 投递层 askUser 过滤（C4 分流）；
 * TC7/TC8 回传双通道（plugin.uiResponse / extension.ui_response 复用）；TC9 onUiTimeout WS 订阅。
 *
 * 策略：convertToDialogRequest 直测（纯函数）；createDialogRequestSource 用真实
 * InternalEventBus（bus.emit）+ dispatchGlobal（onGlobal 通道）——对齐 useExtensionHostBridge.test.ts
 * 全链路范式；createUiResponseTransport 用 vi.mock 断言 send 调用形状。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InternalEventBus } from '@xyz-agent/core'
import type { InternalEvent } from '@xyz-agent/core'
import { dispatchCrossSession } from '@xyz-agent/core/transport/api'

vi.mock('@xyz-agent/core/transport/ws-client', () => ({
  send: vi.fn(),
}))

vi.mock('@xyz-agent/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: vi.fn(),
}))

import { send } from '@xyz-agent/core/transport/ws-client'
import { sendExtensionUIResponse } from '@xyz-agent/core/transport/api/domains/extension'
import {
  convertToDialogRequest,
  createDialogRequestSource,
  createUiResponseTransport,
} from '../extension-host-dialog'

function makeUiRequestEvent(overrides: Partial<{ sessionId: string; pluginId: string; requestId: string; kind: 'select' | 'confirm' | 'input' }> = {}): Extract<InternalEvent, { kind: 'ui-request' }> {
  return {
    kind: 'ui-request',
    sessionId: overrides.sessionId ?? 's1',
    request: {
      requestId: overrides.requestId ?? 'r1',
      pluginId: overrides.pluginId ?? 'p1',
      kind: overrides.kind ?? 'select',
    },
  }
}

describe('convertToDialogRequest（AC2）', () => {
  it('TC1: source 判定——pluginId 非空 → plugin；pluginId 空 → pi', () => {
    const plugin = convertToDialogRequest(makeUiRequestEvent({ pluginId: 'tasks' }))
    expect(plugin.source).toBe('plugin')
    expect(plugin.sessionId).toBe('s1')
    expect(plugin.requestId).toBe('r1')

    const pi = convertToDialogRequest(makeUiRequestEvent({ pluginId: '' }))
    expect(pi.source).toBe('pi')
  })

  it('TC2: askUser 改写——askUser:true → method=askUser + askUserQuestions/allowCancel 透传', () => {
    const e = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.askUser = true
    e.request.askUserQuestions = [{ question: '继续?' }]
    e.request.allowCancel = false

    const req = convertToDialogRequest(e)
    expect(req.method).toBe('askUser')
    expect(req.askUserQuestions).toEqual([{ question: '继续?' }])
    expect(req.allowCancel).toBe(false)
  })

  it('TC3: options 归一——string[] → {label,value}[]；对象数组透传；非法项跳过', () => {
    const e1 = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e1.request.options = ['a', 'b']
    expect(convertToDialogRequest(e1).options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
    ])

    const e2 = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e2.request.options = [
      { label: 'x', value: '1', description: 'desc' },
      42, // 非法项跳过
    ]
    expect(convertToDialogRequest(e2).options).toEqual([{ label: 'x', value: '1', description: 'desc' }])
  })

  it('TC4: method 超界恢复 + receivedAt 补齐——原始 method 优先（editor 透传），无 method 用 kind', () => {
    const e1 = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e1.request.method = 'editor'
    const req1 = convertToDialogRequest(e1)
    expect(req1.method).toBe('editor')
    expect(typeof req1.receivedAt).toBe('number')
    expect(Date.now() - req1.receivedAt).toBeLessThan(5000)

    const req2 = convertToDialogRequest(makeUiRequestEvent({ kind: 'confirm' }))
    expect(req2.method).toBe('confirm')
  })
})

describe('createDialogRequestSource（C2/C3/C4 分流）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    bus = new InternalEventBus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC5: 无 sessionId 事件跳过投递 + console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)

    bus.emit({ kind: 'ui-request', sessionId: undefined, request: { requestId: 'r1', pluginId: 'p1', kind: 'select' } })

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    unsub()
    warn.mockRestore()
  })

  it('TC6: 投递层 askUser 过滤（C4）——askUser:true 不投递，非 askUser 正常投递', () => {
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)

    bus.emit({
      kind: 'ui-request',
      sessionId: 's1',
      request: { requestId: 'r-ask', pluginId: '', kind: 'input', askUser: true },
    })
    expect(handler).not.toHaveBeenCalled()

    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r-dialog', pluginId: '', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)
    const delivered = handler.mock.calls[0][0]
    expect(delivered.requestId).toBe('r-dialog')
    expect(delivered.method).toBe('confirm')
    expect(delivered.source).toBe('pi')
    unsub()
  })

  it('TC9: onUiTimeout 订阅 crossSession 通道的 extension.ui_timeout（C3 保留 WS 路径）', () => {
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiTimeout(handler)

    // MF-6：extension.ui_timeout 广播带 sessionId，route-inbound 落 session 通道 + crossSession 声明条目
    // （crossSession 通道）——用 dispatchCrossSession（runtime 真实广播形状，onGlobal 收不到）
    dispatchCrossSession({ type: 'extension.ui_timeout', payload: { sessionId: 's1', requestId: 'r1' } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ sessionId: 's1', requestId: 'r1' })

    dispatchCrossSession({ type: 'extension:notify', payload: { sessionId: 's1', message: 'hi' } })
    expect(handler).toHaveBeenCalledTimes(1) // 非 timeout 类型零触发
    unsub()
  })
})

describe('createUiResponseTransport（AC6/AC9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC7: sendPluginResponse 发 plugin.uiResponse（runtime handleUiResponse 消费）', () => {
    const t = createUiResponseTransport()
    t.sendPluginResponse('r1', { value: 'x' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'plugin.uiResponse',
      payload: { requestId: 'r1', result: { value: 'x' } },
    })
  })

  it('TC8: sendPiResponse 复用 sendExtensionUIResponse（extension.ui_response，method 透传）', () => {
    const t = createUiResponseTransport()
    t.sendPiResponse('s1', 'r1', 'editor', 'value')
    expect(sendExtensionUIResponse).toHaveBeenCalledTimes(1)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'editor', 'value')
  })

  it('TC8b: sendPiResponse 兜底——非法 method 落到 input（对齐 kind 兜底语义）', () => {
    const t = createUiResponseTransport()
    t.sendPiResponse('s1', 'r1', 'unknown-method', true)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'input', true)
  })
})
