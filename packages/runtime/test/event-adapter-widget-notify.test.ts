/**
 * W2 复杂度重构特征锚定补充测试：handleExtensionUIRequest 按 method 分发提取后
 * 此前无覆盖的分支（特征锚定：事件形态 + 字段值 + kind 顺序）。
 *
 * 覆盖缺口（重构前 grep 全部 event-adapter 测试无命中）：
 * - setWidget 的 subagent-stream-<recordId> 前缀短路分支（kind: 'subagent-stream'）
 * - notify level 映射的 error / 缺省 info 分支（既有测试只锚定 warning → warn）
 * - 未知 method → noop（handleExtensionUIRequest 兜底分支）
 *
 * 直测 translate（纯翻译层，模式同 event-adapter-gui.test.ts，不经 interpreter）。
 * 测试框架：vitest；不触盘、无 fixture 文件。
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import type { PiTranslatedEvent } from '../src/services/session/types.js'
import type { PiEvent } from '../src/infra/pi/pi-protocol.js'

/** 构造 pi extension_ui_request 事件（wire 局部形态，测试只需 type + method 字段） */
function makeUiRequest(fields: Record<string, unknown>): PiEvent {
  return { type: 'extension_ui_request', ...fields } as PiEvent
}

describe('event-adapter: setWidget subagent-stream 前缀短路（路径 A-1）', () => {
  it('widgetKey=subagent-stream-<recordId> → kind:subagent-stream + lines 全 String 化', () => {
    const event = makeUiRequest({
      method: 'setWidget',
      widgetKey: 'subagent-stream-rec-42',
      widgetLines: ['line one', 2],
    })

    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const stream = results[0] as Extract<PiTranslatedEvent, { kind: 'subagent-stream' }>
    expect(stream.kind).toBe('subagent-stream')
    expect(stream.sessionId).toBe('sess-1')
    expect(stream.recordId).toBe('rec-42')
    expect(stream.lines).toEqual(['line one', '2'])
  })

  it('widgetLines 空 → lines 为 undefined（非空数组才映射）', () => {
    const event = makeUiRequest({
      method: 'setWidget',
      widgetKey: 'subagent-stream-rec-7',
      widgetLines: [],
    })

    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const stream = results[0] as Extract<PiTranslatedEvent, { kind: 'subagent-stream' }>
    expect(stream.recordId).toBe('rec-7')
    expect(stream.lines).toBeUndefined()
  })
})

describe('event-adapter: notify level 映射补全（error / 缺省 info）', () => {
  it('notifyType=error → level:error', () => {
    const event = makeUiRequest({ method: 'notify', message: 'boom', notifyType: 'error' })
    const results = translate(event, 'sess-1')

    expect(results).toHaveLength(1)
    const msg = results[0] as Extract<PiTranslatedEvent, { kind: 'message' }>
    expect(msg.message.type).toBe('extension:notify')
    expect(msg.message.payload).toEqual({ sessionId: 'sess-1', message: 'boom', level: 'error' })
  })

  it('notifyType 缺省 → level:info；message 缺省 → 空串', () => {
    const event = makeUiRequest({ method: 'notify' })
    const results = translate(event, 'sess-1')

    const msg = results[0] as Extract<PiTranslatedEvent, { kind: 'message' }>
    expect(msg.message.payload).toEqual({ sessionId: 'sess-1', message: '', level: 'info' })
  })
})

describe('event-adapter: extension_ui_request 未知 method → noop 兜底', () => {
  it('method 不在已知集合且非 interactive → 单个 noop，无任何 WS 帧', () => {
    const results = translate(makeUiRequest({ method: 'totally_unknown' }), 'sess-1')

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ kind: 'noop' })
  })
})
