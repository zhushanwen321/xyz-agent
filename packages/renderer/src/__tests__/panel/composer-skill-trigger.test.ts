/**
 * Composer skill 触发/chip/浮层 单测（多 skill 注入 u4，设计 D1/D2 + 验收场景 6）。
 *
 * 覆盖三组件的垂直切片：
 * - W 组 Composer wiring（挂 Composer + stub CommandPopover）：空格/全角空格/NBSP 后 `/`
 *   触发 skill-only 浮层（场景 6④）；`/usr` 输到第二个 `/` 浮层关闭（场景 6①）；
 *   行首 `/` 仍命令浮层（场景 6② 回归）；`#`/`$`/`@` 无变化（场景 6③ 回归）；
 *   select payload → insertSkillChip（光标标记 chip、多个共存）+ 已选集合回传（D2 已选禁选数据面）
 * - P 组 CommandPopover（真实组件）：panel 态从 commandStore 过滤 source:"skill" 且剥
 *   `skill:` 前缀；已选项「已选」禁选（onSelect 守卫）；landing 态 global+project 合并；
 *   select payload 携带 location（sourceInfo.path）
 *
 * mock 策略与 composer-slash-trigger.test.ts 同款（真实 ComposerInput 走 contenteditable 触发）。
 * happy-dom 光标：skill 触发无程序化兜底（必须有光标），用 typeWithCursor 定位光标末尾。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/composer-skill-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@xyz-agent/core/transport/api/events'
import type { ServerMessage } from '@xyz-agent/shared'
import type { SkillInfo } from '@xyz-agent/shared'

// ── Composer 路径 mock —— vi.mock factory 必须早于 import ──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, currentCwd: ref(null), setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })), getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }) },
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  config: {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  },
}))

import CommandPopover from '@/components/panel/CommandPopover.vue'
import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

// ─────────────────────── W 组：Composer wiring（真实 ComposerInput + stub CommandPopover） ───────────────────────

/** stub 选中 payload（模块级可变：W6 在点击前设置，点击时 emit 给 Composer.onCmdSelect） */
let currentPick: Record<string, unknown> | null = null

/** CommandPopover stub：props 反映到 data-* 供 DOM 断言；cp-pick 按钮模拟选中项 emit select */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'mention' },
    sessionId: { type: String, default: undefined },
    query: { type: String, default: '' },
    selectedSkillNames: { type: Array, default: () => [] },
  },
  emits: ['select'],
  methods: {
    handleKeydown() {
      return false
    },
    emitPick() {
      if (currentPick) this.$emit('select', currentPick)
    },
  },
  template:
    '<div data-testid="cp" :data-open="String(open)" :data-type="type" :data-query="query" :data-selected="(selectedSkillNames || []).join(\',\')"><button data-testid="cp-pick" @click="emitPick" /><slot /></div>',
})

const SIMPLE = { template: '<div />' }
const composerStubs = {
  CommandPopover: CommandPopoverStub,
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

function mountComposer() {
  return mount(Composer, {
    props: { sessionId: 's1', variant: 'panel' },
    global: { stubs: composerStubs },
  })
}

/**
 * 在真实 ComposerInput 的 contenteditable div 内键入并把光标定位到文本末尾。
 * skill 触发无程序化兜底（必须有光标），与 slash 的 startsWith 兜底路径不同。
 */
async function typeWithCursor(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, text.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
  await nextTick()
}

/**
 * 把光标移到输入框末尾（元素级 offset，不重写 DOM——保留已插入的 chip）。
 * 用于模拟「已有 chip 后继续键入再点选」的真实流。
 */
async function cursorToEnd(wrapper: ReturnType<typeof mount>): Promise<void> {
  const el = wrapper.find('[role="textbox"]').element as HTMLDivElement
  el.focus()
  const sel = window.getSelection()
  const last = el.lastChild
  if (sel && last) {
    const range = document.createRange()
    range.setStartAfter(last)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await nextTick()
}

function cp(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="cp"]')
}

describe('Composer skill 触发 wiring（场景 6①②③④）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('W1 空格后键入 /rev → 浮层开、type=skill、query=rev', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '帮我 review /rev')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    expect(cp(wrapper).attributes('data-query')).toBe('rev')
    wrapper.unmount()
  })

  it('W2 场景 6①：/usr 短暂弹出，输到第二个 / 浮层立即关闭', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '帮我看看 /usr')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    await typeWithCursor(wrapper, '帮我看看 /usr/')
    expect(cp(wrapper).attributes('data-open')).toBe('false')
    wrapper.unmount()
  })

  it('W3 场景 6② 回归：行首 /co → 命令浮层（type=slash），skill 路不抢', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '/co')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('slash')
    expect(cp(wrapper).attributes('data-query')).toBe('co')
    wrapper.unmount()
  })

  it('W4 场景 6③ 回归：# / $ / @ 触发类型不变（session/file/subagent）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, 'see #job')
    expect(cp(wrapper).attributes('data-type')).toBe('session')
    await typeWithCursor(wrapper, 'echo $HOME')
    expect(cp(wrapper).attributes('data-type')).toBe('file')
    await typeWithCursor(wrapper, 'hey @build')
    expect(cp(wrapper).attributes('data-type')).toBe('subagent')
    wrapper.unmount()
  })

  it('W5 场景 6④：全角空格 / NBSP 后 / 唤起 skill 浮层', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    await typeWithCursor(wrapper, '看看\u3000/re')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    await typeWithCursor(wrapper, '看看\u00A0/re')
    expect(cp(wrapper).attributes('data-open')).toBe('true')
    expect(cp(wrapper).attributes('data-type')).toBe('skill')
    wrapper.unmount()
  })
})

describe('Composer skill chip 插入与已选回传（D2 已选禁选数据面）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('W6 选中两个 skill → insertSkillChip 两个共存（dataset/location 完整）+ 已选集合回传', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    const cpEl = wrapper.find('[data-testid="cp"]')
    // 真实流：先键入触发（selection 在输入框内），再点选浮层项——insertChipAtSelection
    // 走光标处插入分支（happy-dom 残留脱离文档 selection 会污染插入位置，须先键入定位）
    await typeWithCursor(wrapper, '帮我 /al')
    // 选中 skill alpha（payload 携带 icon/location，onCmdSelect → clearSkillQueryText + insertSkillChip）
    currentPick = { type: 'skill', name: 'alpha', icon: 'star', location: '/s/alpha/SKILL.md' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    let chips = wrapper.findAll('.slash-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].attributes('data-chip-type')).toBe('skill')
    expect(chips[0].attributes('data-chip-name')).toBe('alpha')
    expect(chips[0].attributes('data-chip-location')).toBe('/s/alpha/SKILL.md')
    // 已选集合回传（onInputChange → getSegments → CommandPopover.selectedSkillNames）
    expect(cpEl.attributes('data-selected')).toBe('alpha')
    // 再选一个：两个 skill chip 共存（D2），已选集合含两项（光标移末尾，不重写 DOM 保住 alpha chip）
    await cursorToEnd(wrapper)
    currentPick = { type: 'skill', name: 'beta', icon: 'star' }
    await wrapper.find('[data-testid="cp-pick"]').trigger('click')
    await nextTick()
    chips = wrapper.findAll('.slash-chip')
    expect(chips.length).toBe(2)
    expect(chips[1].attributes('data-chip-name')).toBe('beta')
    expect(chips[1].attributes('data-chip-location')).toBeUndefined()
    expect(cpEl.attributes('data-selected')).toBe('alpha,beta')
    currentPick = null
    wrapper.unmount()
  })
})

// ─────────────────────── P 组：CommandPopover skill-only 候选（真实组件） ───────────────────────

/** 推 session.commands 到 sessionId 订阅者（同 slash-trigger 测试机械） */
function pushCommands(sessionId: string, commands: Array<Record<string, unknown>>): void {
  const msg = {
    type: 'session.commands',
    payload: { sessionId, commands },
  } as ServerMessage<'session.commands'>
  events.dispatchSession(sessionId, msg)
}

/** reka-ui PopoverContent teleport 到 body：在列表容器内找 .cmd-row 行 */
function bodyRows(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.cmd-row')) as HTMLElement[]
}

/** SkillInfo fixture（landing 候选源形状） */
function skillInfo(name: string, sourcePath?: string): SkillInfo {
  return { id: `pi-${name}`, name, description: `${name} desc`, enabled: true, source: 'global', triggers: [], sourcePath }
}

describe('CommandPopover skill-only 候选（D1 数据源 + D2 已选禁选）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('P1 panel 态：只列 source=skill 项、剥 skill: 前缀、__ 内部项过滤', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '' },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', description: 'A', source: 'skill' },
      { name: 'commit', description: 'ext', source: 'extension' },
      { name: 'skill:beta', source: 'skill' },
      { name: 'skill:__xyz_reload', source: 'skill' },
    ])
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('alpha')
    expect(rows[1].textContent).toContain('beta')
    expect(bodyRows().some((r) => r.textContent?.includes('commit'))).toBe(false)
    expect(bodyRows().some((r) => r.textContent?.includes('__xyz_reload'))).toBe(false)
  })

  it('P2 D2 已选禁选：已选项显示「已选」且禁选（不 emit select），未选项正常选', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '', selectedSkillNames: ['alpha'] },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', source: 'skill' },
      { name: 'skill:beta', source: 'skill' },
    ])
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows[0].getAttribute('aria-disabled')).toBe('true')
    expect(rows[0].textContent).toContain('已选')
    rows[0].click()
    await nextTick()
    expect(wrapper.emitted('select')).toBeUndefined()
    rows[1].click()
    await nextTick()
    expect(wrapper.emitted('select')!.length).toBe(1)
    expect(wrapper.emitted('select')![0][0]).toMatchObject({ type: 'skill', name: 'beta' })
  })

  it('P3 panel 态 select payload 携带 location（sourceInfo.path）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'skill', sessionId: 's1', query: '' },
    })
    await flushPromises()
    pushCommands('s1', [
      { name: 'skill:alpha', source: 'skill', sourceInfo: { path: '/s/alpha/SKILL.md', source: 'skill' } },
    ])
    await flushPromises()
    await nextTick()
    bodyRows()[0].click()
    await nextTick()
    expect(wrapper.emitted('select')![0][0]).toMatchObject({
      type: 'skill',
      name: 'alpha',
      location: '/s/alpha/SKILL.md',
    })
  })

  it('P4 landing 态：globalSkills + projectSkills 合并（global 优先、project 补独有、去重）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: {
        open: true,
        type: 'skill',
        variant: 'landing',
        query: '',
        globalSkills: [skillInfo('global-a', '/g/a/SKILL.md'), skillInfo('shared')],
        projectSkills: [skillInfo('shared'), skillInfo('proj-c')],
      },
    })
    await flushPromises()
    await nextTick()
    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('global-a')
    expect(rows[1].textContent).toContain('shared')
    expect(rows[2].textContent).toContain('proj-c')
    // landing 选中：location 取 SkillInfo.sourcePath
    rows[0].click()
    await nextTick()
    expect(wrapper.emitted('select')![0][0]).toMatchObject({ type: 'skill', name: 'global-a', location: '/g/a/SKILL.md' })
  })
})
