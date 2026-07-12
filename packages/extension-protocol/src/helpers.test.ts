import { describe, it, expect } from 'vitest'
import {
  guiResult,
  guiComponent,
  guiSetWidget,
  isGuiCapable,
  isGuiComponent,
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
    const component = guiComponent('stats-line', {
      items: [{ value: '3 turns' }],
    })
    const result = guiResult(component)
    expect(result.v).toBe(PROTOCOL_VERSION)
    expect(result.component.type).toBe('stats-line')
  })

  it('strip undefined 字段（序列化干净）', () => {
    const component = guiComponent('stats-line', {
      items: [{ value: 'x', label: undefined }],
    })
    const result = guiResult(component)
    const serialized = JSON.parse(JSON.stringify(result))
    // label 为 undefined，不应出现在序列化结果中
    expect('label' in serialized.component.props.items[0]).toBe(false)
  })
})

describe('guiComponent', () => {
  it('正确构造 stats-line 组件', () => {
    const c = guiComponent('stats-line', {
      items: [{ value: '3 turns', label: 'turns' }],
    })
    expect(c.type).toBe('stats-line')
    expect(c.props.items).toHaveLength(1)
    expect(c.props.items[0].label).toBe('turns')
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
    const component = guiComponent('stats-line', { items: [{ value: 'x' }] })
    guiSetWidget(ctx, 'todo', component)

    expect(captured).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured![0].startsWith(GUI_WIDGET_MARKER)).toBe(true)

    const json = captured![0].slice(GUI_WIDGET_MARKER.length)
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe('stats-line')
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
        component: { type: 'stats-line', props: { items: [] } },
      },
      otherField: 'value',
    }
    const result = extractGui(details)
    expect(result).toBeDefined()
    expect(result!.v).toBe(1)
    expect(result!.component.type).toBe('stats-line')
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

describe('isGuiComponent', () => {
  it('合法 GuiComponent（type 字符串 + props 对象）→ true', () => {
    expect(isGuiComponent({ type: 'stats-line', props: { items: [] } })).toBe(true)
    expect(isGuiComponent({ type: 'ansi-text', props: { lines: ['a'] } })).toBe(true)
  })

  it('缺 type 或 type 非字符串 → false', () => {
    expect(isGuiComponent({ props: {} })).toBe(false)
    expect(isGuiComponent({ type: 42, props: {} })).toBe(false)
  })

  it('缺 props 或 props 非对象 → false', () => {
    expect(isGuiComponent({ type: 'stats-line' })).toBe(false)
    expect(isGuiComponent({ type: 'stats-line', props: 'not-object' })).toBe(false)
  })

  it('props 为 null → false（typeof null === object 陷阱）', () => {
    expect(isGuiComponent({ type: 'stats-line', props: null })).toBe(false)
  })

  it('null/非对象 → false', () => {
    expect(isGuiComponent(null)).toBe(false)
    expect(isGuiComponent('string')).toBe(false)
    expect(isGuiComponent(undefined)).toBe(false)
  })
})
