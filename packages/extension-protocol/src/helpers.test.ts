import { describe, it, expect } from 'vitest'
import {
  guiResult,
  guiComponent,
  guiSetWidget,
  isGuiCapable,
  extractGui,
  GUI_WIDGET_MARKER,
  PROTOCOL_VERSION,
  type GuiContext,
} from './index'

describe('isGuiCapable', () => {
  it('rpc 模式返回 true', () => {
    expect(isGuiCapable({ mode: 'rpc', hasUI: true })).toBe(true)
  })

  it('tui 模式返回 false', () => {
    expect(isGuiCapable({ mode: 'tui', hasUI: true })).toBe(false)
  })

  it('json 模式返回 false', () => {
    expect(isGuiCapable({ mode: 'json', hasUI: false })).toBe(false)
  })
})

describe('guiResult', () => {
  it('构造带版本号的 GuiRenderResult', () => {
    const component = guiComponent('task-list', {
      items: [{ id: 1, text: 'test', status: 'pending' }],
    })
    const result = guiResult(component)
    expect(result.v).toBe(PROTOCOL_VERSION)
    expect(result.component.type).toBe('task-list')
  })

  it('strip undefined 字段（序列化干净）', () => {
    const component = guiComponent('task-list', {
      items: [],
      summary: undefined,
    })
    const result = guiResult(component)
    const serialized = JSON.parse(JSON.stringify(result))
    // summary 为 undefined，不应出现在序列化结果中
    expect('summary' in serialized.component.props).toBe(false)
  })
})

describe('guiComponent', () => {
  it('正确构造 task-list 组件', () => {
    const c = guiComponent('task-list', {
      items: [{ id: 'a', text: 'task', status: 'in_progress' }],
      summary: '1/1 completed',
    })
    expect(c.type).toBe('task-list')
    expect(c.props.items).toHaveLength(1)
    expect(c.props.summary).toBe('1/1 completed')
  })

  it('正确构造 ansi-text 组件', () => {
    const c = guiComponent('ansi-text', { lines: ['line1', 'line2'] })
    expect(c.type).toBe('ansi-text')
    expect(c.props.lines).toEqual(['line1', 'line2'])
  })

  it('正确构造 card 布局原语', () => {
    const inner = guiComponent('stats-line', {
      items: [{ value: '3 turns' }],
    })
    const c = guiComponent('card', { body: [inner] })
    expect(c.type).toBe('card')
    expect(c.props.body).toHaveLength(1)
    expect(c.props.body[0].type).toBe('stats-line')
  })
})

describe('guiSetWidget', () => {
  it('RPC 模式用 marker 编码 GuiComponent JSON', () => {
    let captured: string[] | undefined
    const ctx: GuiContext = {
      mode: 'rpc',
      hasUI: true,
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) => {
          captured = lines
        },
      },
    }
    const component = guiComponent('task-list', { items: [] })
    guiSetWidget(ctx, 'todo', component)

    expect(captured).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured![0].startsWith(GUI_WIDGET_MARKER)).toBe(true)

    const json = captured![0].slice(GUI_WIDGET_MARKER.length)
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe('task-list')
  })

  it('传 undefined 清除 widget', () => {
    let captured: string[] | undefined = ['existing']
    const ctx: GuiContext = {
      mode: 'rpc',
      hasUI: true,
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) => {
          captured = lines
        },
      },
    }
    guiSetWidget(ctx, 'todo', undefined)
    expect(captured).toBeUndefined()
  })

  it('无 ui.setWidget 时安全无操作', () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    // 不应抛错
    guiSetWidget(ctx, 'todo', guiComponent('ansi-text', { lines: [] }))
  })
})

describe('extractGui', () => {
  it('从含 __gui__ 的 details 中提取 GuiRenderResult', () => {
    const details = {
      __gui__: {
        v: 1,
        component: { type: 'task-list', props: { items: [] } },
      },
      otherField: 'value',
    }
    const result = extractGui(details)
    expect(result).toBeDefined()
    expect(result!.v).toBe(1)
    expect(result!.component.type).toBe('task-list')
  })

  it('无 __gui__ 返回 undefined', () => {
    expect(extractGui({ foo: 'bar' })).toBeUndefined()
  })

  it('undefined details 返回 undefined', () => {
    expect(extractGui(undefined)).toBeUndefined()
  })

  it('__gui__ 缺少 v 或 component 返回 undefined', () => {
    expect(extractGui({ __gui__: { v: 1 } })).toBeUndefined()
    expect(extractGui({ __gui__: { component: {} } })).toBeUndefined()
  })
})
