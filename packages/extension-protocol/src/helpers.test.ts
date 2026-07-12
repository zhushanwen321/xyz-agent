import { describe, it, expect } from 'vitest'
import {
  guiResult,
  guiComponent,
  guiSetWidget,
  isGuiCapable,
  isGuiComponent,
  extractGui,
  guiInteract,
  getInteractionAnswer,
  getInteractionOther,
  getInteractionComment,
  GUI_WIDGET_MARKER,
  GUI_INTERACT_MARKER,
  PROTOCOL_VERSION,
  type GuiContext,
  type InteractionQuestion,
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

describe('isGuiComponent', () => {
  it('合法 GuiComponent（type 字符串 + props 对象）→ true', () => {
    expect(isGuiComponent({ type: 'task-list', props: { items: [] } })).toBe(true)
    expect(isGuiComponent({ type: 'ansi-text', props: { lines: ['a'] } })).toBe(true)
  })

  it('缺 type 或 type 非字符串 → false', () => {
    expect(isGuiComponent({ props: {} })).toBe(false)
    expect(isGuiComponent({ type: 42, props: {} })).toBe(false)
  })

  it('缺 props 或 props 非对象 → false', () => {
    expect(isGuiComponent({ type: 'task-list' })).toBe(false)
    expect(isGuiComponent({ type: 'task-list', props: 'not-object' })).toBe(false)
  })

  it('props 为 null → false（typeof null === object 陷阱）', () => {
    expect(isGuiComponent({ type: 'task-list', props: null })).toBe(false)
  })

  it('null/非对象 → false', () => {
    expect(isGuiComponent(null)).toBe(false)
    expect(isGuiComponent('string')).toBe(false)
    expect(isGuiComponent(undefined)).toBe(false)
  })
})

// ── 富交互：guiInteract + 解析 helper + marker（U1-U5）──

/** 构造带 mock select 的 RPC ctx */
function makeRpcCtx(selectImpl: (header: string, options: string[]) => Promise<string | undefined>): GuiContext {
  return {
    mode: 'rpc',
    hasUI: true,
    ui: {
      select: (header: string, options: string[]) => selectImpl(header, options),
    },
  }
}

describe('guiInteract', () => {
  it('U1: RPC 模式 select 返回 JSON string → 解析出 answers', async () => {
    const mockAnswers = { db: 'postgres', 'db__comment': 'prod 用 pg' }
    const ctx = makeRpcCtx(async (_header, _options) => JSON.stringify(mockAnswers))

    const questions: InteractionQuestion[] = [
      { header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres', value: 'postgres' }] },
    ]
    const result = await guiInteract(ctx, questions)

    expect(result).toEqual(mockAnswers)
  })

  it('U1: select 收到 title=marker + options[0]=JSON payload', async () => {
    let capturedHeader: string | undefined
    let capturedOptions: string[] | undefined
    const ctx = makeRpcCtx(async (header, options) => {
      capturedHeader = header
      capturedOptions = options
      return JSON.stringify({})
    })

    const questions: InteractionQuestion[] = [
      { header: 'lang', question: 'q', options: [{ label: 'TS' }] },
    ]
    await guiInteract(ctx, questions, { allowCancel: false })

    expect(capturedHeader).toBe(GUI_INTERACT_MARKER)
    expect(capturedOptions).toHaveLength(1)
    const payload = JSON.parse(capturedOptions![0])
    expect(payload.questions).toEqual(questions)
    expect(payload.allowCancel).toBe(false)
  })

  it('U2: select 返回 undefined（用户取消/超时）→ null', async () => {
    const ctx = makeRpcCtx(async () => undefined)
    const result = await guiInteract(ctx, [{ header: 'x', question: 'q' }])
    expect(result).toBeNull()
  })

  it('U3: select 返回非法 JSON → null（视为取消）', async () => {
    const ctx = makeRpcCtx(async () => 'not-json{')
    const result = await guiInteract(ctx, [{ header: 'x', question: 'q' }])
    expect(result).toBeNull()
  })

  it('U4: GUI_INTERACT_MARKER 常量值正确（NUL 前缀）', () => {
    expect(GUI_INTERACT_MARKER).toBe('\x00XYZ_GUI_INTERACT')
    expect(GUI_INTERACT_MARKER.startsWith('\x00')).toBe(true)
  })

  it('U4: TUI 模式抛错（不返回 null 避免与取消混淆）', async () => {
    const ctx: GuiContext = { mode: 'tui', hasUI: true }
    await expect(
      guiInteract(ctx, [{ header: 'x', question: 'q' }]),
    ).rejects.toThrow('only available in RPC mode')
  })

  it('U4: 空 questions 返回 {}（不报错）', async () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    const result = await guiInteract(ctx, [])
    expect(result).toEqual({})
  })
})

describe('getInteractionAnswer / getInteractionOther / getInteractionComment', () => {
  it('U5: 单选——返回 string value', () => {
    const q: InteractionQuestion = { header: 'db', question: 'q', options: [{ label: 'PG', value: 'pg' }] }
    const answers = { db: 'pg' }
    expect(getInteractionAnswer(answers, q)).toBe('pg')
  })

  it('U5: 多选——JSON.parse 返回 string[]', () => {
    const q: InteractionQuestion = { header: 'lang', question: 'q', multiSelect: true, options: [] }
    const answers = { lang: '["ts","py"]' }
    expect(getInteractionAnswer(answers, q)).toEqual(['ts', 'py'])
  })

  it('U5: 多选 JSON.parse 失败 → 降级返回 [raw]', () => {
    const q: InteractionQuestion = { header: 'lang', question: 'q', multiSelect: true }
    const answers = { lang: 'not-json' }
    expect(getInteractionAnswer(answers, q)).toEqual(['not-json'])
  })

  it('U5: header 缺失时用 question 文本做 key', () => {
    const q: InteractionQuestion = { question: '选哪个?' }
    const answers = { '选哪个?': 'val' }
    expect(getInteractionAnswer(answers, q)).toBe('val')
  })

  it('U5: answers 无对应 key → undefined', () => {
    const q: InteractionQuestion = { header: 'x', question: 'q' }
    expect(getInteractionAnswer({}, q)).toBeUndefined()
  })

  it('U5: getInteractionOther 提取 Other 自由文本', () => {
    const q: InteractionQuestion = { header: 'db', question: 'q' }
    const answers = { db: 'pg', 'db__other': '自定义理由' }
    expect(getInteractionOther(answers, q)).toBe('自定义理由')
  })

  it('U5: getInteractionComment 提取评论', () => {
    const q: InteractionQuestion = { header: 'db', question: 'q' }
    const answers = { db: 'pg', 'db__comment': 'prod 用 pg' }
    expect(getInteractionComment(answers, q)).toBe('prod 用 pg')
  })

  it('U5: Other/Comment 缺失 → undefined', () => {
    const q: InteractionQuestion = { header: 'db', question: 'q' }
    expect(getInteractionOther({ db: 'pg' }, q)).toBeUndefined()
    expect(getInteractionComment({ db: 'pg' }, q)).toBeUndefined()
  })
})
