/**
 * Composer # 文件触发补全 单测。
 *
 * 覆盖 # inline 触发的垂直切片（对照 composer-slash-trigger.test.ts 范式）：
 * - U1-U6 ComposerInput.detectHashTrigger 光标位置触发检测
 *   （# 前空格/行首 + # 后非空白 → 触发；遇空格 → 终止）
 * - U7-U9 CommandPopover file 分支 query 过滤（name + path）+ 路径展示
 * - U10 Composer wiring（file-trigger 事件路由）
 *
 * 关键差异（vs slash）：# 是「任意位置」触发，detectHashTrigger 基于 Selection 光标位置
 * 判断，不靠整框文本 startsWith。故测试必须把光标定位到文本节点内指定位置。
 *
 * happy-dom 光标支持：el.focus() + Range.setStart/setEnd + Selection.addRange 可定位光标。
 * 若 happy-dom 不支持，降级用真实 Range + trigger('input')（detectHashTrigger 读 selection）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/composer-hash-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── Composer 路径 mock（U10）—— vi.mock factory 必须早于 import ──
vi.mock('@/composables/features/useChat', () => ({
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
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
}))

import ComposerInput from '@/components/panel/ComposerInput.vue'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

// ─────────────────────── U1-U6 ComposerInput detectHashTrigger ───────────────────────

/**
 * 在 contenteditable div 内键入文本，并把光标定位到指定位置（detectHashTrigger 依赖光标位置）。
 * 策略：设 textContent → focus → 用 Range 把光标 collapse 到 offset → trigger('input')。
 * detectHashTrigger 读 window.getSelection().anchorNode/anchorOffset 判断。
 */
async function typeWithCursor(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  // 定位光标到文本节点的 cursorOffset 位置
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
}

describe('ComposerInput file-trigger（U1-U6）', () => {
  it('U1 行首敲 #（光标紧随 #）→ emit file-trigger {query:""}', async () => {
    const wrapper = mount(ComposerInput)
    // 文本 "#"，光标在 offset=1（# 之后）
    await typeWithCursor(wrapper, '#', 1)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: '' })
  })

  it('U2 #auth（光标在末尾）→ emit file-trigger {query:"auth"}', async () => {
    const wrapper = mount(ComposerInput)
    await typeWithCursor(wrapper, '#auth', 5)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'auth' })
  })

  it('U3 #auth 后跟空格（光标在空格后）→ emit file-trigger null（终止）', async () => {
    const wrapper = mount(ComposerInput)
    // 文本 "#auth "（末尾空格），光标在 offset=6（空格后）
    await typeWithCursor(wrapper, '#auth ', 6)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U4 问题#1（# 前非空格）→ emit file-trigger null', async () => {
    const wrapper = mount(ComposerInput)
    // "问题#1"，# 前是"题"（非空格/行首），光标在末尾
    await typeWithCursor(wrapper, '问题#1', 4)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U5 code #a（# 前空格）→ emit file-trigger {query:"a"}', async () => {
    const wrapper = mount(ComposerInput)
    // "code #a"，# 前是空格，光标在末尾
    await typeWithCursor(wrapper, 'code #a', 7)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'a' })
  })

  it('U6 触发后清空 → emit file-trigger null（关闭浮层）', async () => {
    const wrapper = mount(ComposerInput)
    await typeWithCursor(wrapper, '#auth', 5)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toEqual({ query: 'auth' })
    // 清空
    await typeWithCursor(wrapper, '', 0)
    expect(wrapper.emitted('file-trigger')!.at(-1)![0]).toBeNull()
  })
})

// ─────────────────────── U7-U9 CommandPopover file 过滤 + 路径 ───────────────────────

// mock useFileSearch：返回可控 FileNode[]（含同名不同路径，验证 path 过滤 + 路径展示）
const mockLoad = vi.fn()
vi.mock('@/composables/features/useFileSearch', () => ({
  useFileSearch: () => ({ load: (...args: unknown[]) => mockLoad(...args) }),
}))

import type { FileNode } from '@xyz-agent/shared'

// 两条同源不同路径的 auth 文件 + 一条 tools 目录（验证 query 命中 path 与 name）
const MOCK_FILES: FileNode[] = [
  { path: 'src/auth/token.ts', name: 'token.ts', type: 'file' },
  { path: 'src/auth/AuthService.ts', name: 'AuthService.ts', type: 'file' },
  { path: 'tools/auth.ts', name: 'auth.ts', type: 'file' },
  { path: 'utils/format.ts', name: 'format.ts', type: 'file' },
  { path: 'src/utils', name: 'utils', type: 'dir' },
]

describe('CommandPopover file query 过滤 + 路径展示（U7-U9）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountFilePopover(query: string): Promise<void> {
    mockLoad.mockResolvedValueOnce(MOCK_FILES)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1', query },
    })
    await flushPromises()
    await nextTick()
  }

  /** body 内的 file 候选按钮（含文件名/路径文本） */
  function bodyButtons(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('button')).filter((b) => {
      const t = b.textContent ?? ''
      // 排除空按钮，保留含候选文本的
      return t.includes('.ts') || t.includes('/') || t.includes('utils')
    })
  }

  it('U7 query="auth" → 命中 name+path 含 auth 的 3 条（src/auth/* + tools/auth.ts）', async () => {
    await mountFilePopover('auth')
    const btns = bodyButtons()
    // src/auth/token.ts（path 含 auth）、AuthService.ts（path 含 auth）、tools/auth.ts（name+path 含 auth）
    // utils/format.ts 和 src/utils 不含 auth，被过滤
    expect(btns).toHaveLength(3)
    const texts = btns.map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('token.ts'))).toBe(true)
    expect(texts.some((t) => t.includes('AuthService.ts'))).toBe(true)
    expect(texts.some((t) => t.includes('auth.ts'))).toBe(true)
    // 被过滤的不应出现
    expect(texts.some((t) => t.includes('format.ts'))).toBe(false)
  })

  it('U8 query="zzz" → 0 项，PopoverContent 不渲染', async () => {
    await mountFilePopover('zzz')
    expect(bodyButtons()).toHaveLength(0)
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('U9 两行展示：文件名主行 + 父目录路径副行（区分同名文件）', async () => {
    // 用全量候选（空 query），验证两行布局
    await mountFilePopover('')
    const btns = bodyButtons()
    // src/auth/token.ts → 主行 token.ts + 副行 src/auth/
    const tokenBtn = btns.find((b) => (b.textContent ?? '').includes('token.ts'))
    expect(tokenBtn).toBeDefined()
    expect(tokenBtn?.textContent ?? '').toContain('src/auth/') // 副行显示父目录路径
    // 目录 src/utils → 主行 utils/（basename+/）+ 副行 src/（父目录）
    // 同名目录靠副行父路径区分（src/utils/ vs tools/utils/）
    const utilsBtn = btns.find((b) => {
      const t = b.textContent ?? ''
      return t.includes('utils/') && t.includes('src/')
    })
    expect(utilsBtn).toBeDefined()
  })
})

// ─────────────────────── U10 Composer wiring ───────────────────────

/** CommandPopover stub：把 props 反映到 data-* 属性供 DOM 断言 */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'file' },
    sessionId: { type: String, default: undefined },
    query: { type: String, default: '' },
  },
  methods: {
    handleKeydown() {
      return false
    },
  },
  template:
    '<div data-testid="cp" :data-open="String(open)" :data-type="type" :data-query="query"><slot /></div>',
})

const AddMenuPopoverStub = defineComponent({
  name: 'AddMenuPopover',
  emits: ['select'],
  template: '<button data-testid="add-cmd" @click="$emit(\'select\', \'slash\')" />',
})

const SIMPLE = { template: '<div />' }
const composerStubs = {
  CommandPopover: CommandPopoverStub,
  AddMenuPopover: AddMenuPopoverStub,
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

describe('Composer file-trigger wiring（U10）', () => {
  it('U10 ComposerInput emit file-trigger {query:"auth"} → CommandPopover 收到 open/type=file/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 真实 ComposerInput：键入 #auth 触发 file-trigger → Composer 路由到 CommandPopover
    const input = wrapper.find('[role="textbox"]')
    const el = input.element as HTMLDivElement
    el.textContent = '#auth'
    el.focus()
    const sel = window.getSelection()
    if (sel && el.firstChild) {
      const range = document.createRange()
      range.setStart(el.firstChild, 5) // 光标在 #auth 末尾
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    await input.trigger('input')
    await nextTick()

    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('file')
    expect(cp.attributes('data-query')).toBe('auth')
  })
})
