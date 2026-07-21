/**
 * Composer slash 命令触发补全 单测（W1）。
 *
 * 覆盖三组件的垂直切片：
 * - U1-U5 ComposerInput.onInput 触发检测（DOM 查询 + startsWith，不靠 getText 判 chip）
 * - U6-U8 CommandPopover.items query 过滤（slash 路径）
 * - U9-U10 Composer wiring（slash-trigger 事件路由 + +菜单不回归守卫）
 *
 * mock 策略：
 * - U1-U5 直挂载 ComposerInput（根元素即 contenteditable div），setTextContent + trigger('input')，
 *   断言 emitted('slash-trigger')。happy-dom 支持 TreeWalker/querySelector。
 * - U6-U8 直挂载 CommandPopover（attachTo:body，reka-ui PopoverContent  teleport 到 body），
 *   经 events.dispatchSession 推 session.commands，setProps({query})，断言 body 内 item 按钮数。
 * - U9-U10 mount Composer（stub 子组件 + 真 pinia + mock useChat/useNewTaskFlow/@/api），
 *   从 stub emit slash-trigger/select，断言 CommandPopover stub 收到的 props。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/composer-slash-trigger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@/api/events'
import type { ServerMessage } from '@xyz-agent/shared'

// ── Composer 路径 mock（U9-U10）—— vi.mock factory 必须早于 import ──
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
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, currentCwd: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  // CommandPopover.loadCandidates onMounted 调 composer.getMentionCandidates/getFileCandidates，
  // mock 遗漏会导致 unhandled rejection（test 期间的 4 个 unhandled errors 根因）
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

// ─────────────────────── U1-U5 ComposerInput 触发检测 ───────────────────────

describe('ComposerInput slash-trigger（U1-U5）', () => {
  // ComposerInput template 含注释+div 两个根节点（fragment），wrapper.element 是注释节点。
  // 用 role="textbox" 选择器定位真实 contenteditable div 再触发 input。
  async function type(wrapper: ReturnType<typeof mount>, html: string): Promise<void> {
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    await div.trigger('input')
  }

  it('U1 输入 / → emit slash-trigger {query:""}', async () => {
    const wrapper = mount(ComposerInput)
    await type(wrapper, '/')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: '' })
  })

  it('U2 输入 /commit → emit slash-trigger {query:"commit"}', async () => {
    const wrapper = mount(ComposerInput)
    await type(wrapper, '/commit')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: 'commit' })
  })

  it('U3 已有 slash-chip → emit slash-trigger null（不重触发，DOM 查询判定）', async () => {
    const wrapper = mount(ComposerInput)
    // chip 本体文本 /commit 会被 getText 读入，但 querySelector 查到 chip → 不触发
    await type(wrapper, '<span class="slash-chip">/commit</span>')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U4 非 / 开头（foo/）→ emit slash-trigger null', async () => {
    const wrapper = mount(ComposerInput)
    await type(wrapper, 'foo/')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })

  it('U5 触发后清空 → emit slash-trigger null（关闭浮层）', async () => {
    const wrapper = mount(ComposerInput)
    await type(wrapper, '/commit')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toEqual({ query: 'commit' })
    await type(wrapper, '')
    expect(wrapper.emitted('slash-trigger')!.at(-1)![0]).toBeNull()
  })
})

// ─────────────────────── U6-U8 CommandPopover query 过滤 ───────────────────────

/**
 * 3 条 mock slash 命令（pi get_commands 真实返回的 extension/skill 动态命令）。
 * pi getCommands 返回的 name 不带 / 前缀（真实行为，已由 runtime 日志确认：
 * 'goal' / 'todos' / 'skill:xxx'），CommandPopover.items 会归一化补 / 前缀显示。
 * mock 用无前缀形式覆盖归一化逻辑，避免像旧 fixture 全带 / 掩盖 bug。
 *
 * compact 不在此列——pi get_commands 不返回 builtin（builtin 仅服务 pi TUI
 * autocomplete，不通过 RPC 暴露），由 CommandPopover slashCommands computed 在
 * 前端注入。U7 断言 4 项 = 3 pi 命令 + 1 前端注入 compact。
 */
const MOCK_CMDS = [
  { name: 'commit', source: 'extension' },
  { name: 'review', source: 'extension' },
  { name: 'fix', source: 'skill' },
]

/** 推 session.commands 到 sessionId 订阅者（CommandPopover 用 events.on(sessionId) 订阅） */
function pushCommands(sessionId: string): void {
  const msg = {
    type: 'session.commands',
    payload: { sessionId, commands: MOCK_CMDS },
  } as ServerMessage<'session.commands'>
  events.dispatchSession(sessionId, msg)
}

/** reka-ui PopoverContent teleport 到 body：在 body 内找 item 按钮（v-for Button 渲染为 native <button>）。
 *  按 item 列表容器（.max-h-[180px]）定位——不依赖 button 文本含 /（skill 项显示去掉了 / 前缀）。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('button'))
}

describe('CommandPopover slash query 过滤（U6-U8）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountPopover(query: string): Promise<void> {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: 's1', query },
    })
    await flushPromises()
    pushCommands('s1')
    await flushPromises()
    await nextTick()
  }

  it('U6 query="comm" → 仅渲染 /commit（1 项）', async () => {
    await mountPopover('comm')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('/commit')
  })

  it('U7 query="" → 渲染全部 4 项（3 pi 命令 + 1 前端注入 compact）', async () => {
    await mountPopover('')
    expect(bodyItemButtons()).toHaveLength(4)
    // 确认 compact 确实由前端注入（不在 MOCK_CMDS 里）
    expect(bodyItemButtons().some((b) => b.textContent?.includes('/compact'))).toBe(true)
  })

  it('U8 query="zzz" → 0 项，PopoverContent 不渲染（v-if items.length>0）', async () => {
    await mountPopover('zzz')
    expect(bodyItemButtons()).toHaveLength(0)
    // PopoverContent 整体未挂载（无命令项按钮，无 cmd-pop 容器）
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  // ── U8b 键盘导航幂等（回归：window capture + 事件冒泡双入口曾导致 ↑↓ 跳两项）──
  // handleKeydown 对同一个 KeyboardEvent 第二次调用必须 no-op（defaultPrevented 守卫），
  // 否则 activeIndex 被增减两次 → 方向键跳两项。
  it('U8b ArrowDown 同一事件二次调用 handleKeydown → activeIndex 只进 1（幂等守卫）', async () => {
    await mountPopover('')
    const vm = wrapper!.vm as unknown as { handleKeydown: (e: KeyboardEvent) => boolean }
    // 第一次（模拟 window capture 入口）：消费成功，preventDefault
    const e1 = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    expect(vm.handleKeydown(e1)).toBe(true)
    expect(e1.defaultPrevented).toBe(true)
    // 第二次（模拟事件冒泡到 Composer 入口）：同一事件已 defaultPrevented → no-op，返回 false
    const before = (vm as unknown as { activeIndex: number }).activeIndex
    const ret2 = vm.handleKeydown(e1)
    expect(ret2).toBe(false)
    expect((vm as unknown as { activeIndex: number }).activeIndex).toBe(before) // 未二次跳动
  })
})

// ─────────────────────── U9-U10 Composer wiring ───────────────────────
// global.stubs 的 stub 不留组件实例（findComponent 不可见），改用 DOM 验证：
// - ComposerInput 真实渲染（不 stub），通过 contenteditable div 操作触发 slash-trigger
// - CommandPopover stub 把 open/type/query 反映到 data-* 属性供 DOM 断言
// - AddMenuPopover stub 渲染可点击按钮 emit select

/** CommandPopover stub：把 props 反映到 data-* 属性供 DOM 断言 */
const CommandPopoverStub = defineComponent({
  name: 'CommandPopover',
  props: {
    open: { type: Boolean, default: false },
    type: { type: String, default: 'mention' },
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

/** AddMenuPopover stub：点击 emit select('slash')，模拟 +菜单选命令 */
const AddMenuPopoverStub = defineComponent({
  name: 'AddMenuPopover',
  emits: ['select'],
  template: '<button data-testid="add-slash" @click="$emit(\'select\', \'slash\')" />',
})

const SIMPLE = { template: '<div />' }
/** ComposerInput 保持真实（需通过 contenteditable 触发 slash-trigger） */
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

/** 在真实 ComposerInput 的 contenteditable div 内键入并触发 slash-trigger */
async function typeIntoComposerInput(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const input = wrapper.find('[role="textbox"]')
  ;(input.element as HTMLDivElement).textContent = text
  await input.trigger('input')
  await nextTick()
}

describe('Composer slash-trigger wiring（U9-U10）', () => {
  it('U9 ComposerInput emit slash-trigger {query:"co"} → CommandPopover 收到 open/type/query', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // 真实 ComposerInput：键入 /co 触发 slash-trigger → Composer 路由到 CommandPopover
    await typeIntoComposerInput(wrapper, '/co')
    const cp = wrapper.find('[data-testid="cp"]')
    expect(cp.attributes('data-open')).toBe('true')
    expect(cp.attributes('data-type')).toBe('slash')
    expect(cp.attributes('data-query')).toBe('co')
  })

  it('U10 +菜单打开浮层后 emit slash-trigger null → 浮层不误关（slashTriggerActive=false 守卫）', async () => {
    const wrapper = mountComposer()
    await flushPromises()
    // ① +菜单选 slash → 打开浮层（onAddSelect，slashTriggerActive 仍 false）
    await wrapper.find('[data-testid="add-slash"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="cp"]').attributes('data-open')).toBe('true')
    // ② ComposerInput 键入普通文本 x（非 / 开头）→ emit slash-trigger null
    //    → slashTriggerActive=false（+菜单路径）→ 不误关浮层
    await typeIntoComposerInput(wrapper, 'x')
    expect(wrapper.find('[data-testid="cp"]').attributes('data-open')).toBe('true')
  })
})

// ─────────────────────── U11 insertSlashChip / 前缀归一化 ───────────────────────

describe('insertSlashChip / 前缀归一化（U11）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /**
   * pi getCommands 返回的命令名不带 / 前缀（如 'goal'），但发送给 pi 必须以 / 开头，
   * 否则 pi 按普通文本处理而非 slash 命令。insertSlashChip 必须归一化补 /。
   * 回归场景：用户选 /goal 命令 → chip 显示 'goal' → 发送 'goal' → pi 不识别。
   */
  it('U11a insertSlashChip("goal") → chip label 显示 "/goal"（补 / 前缀）', async () => {
    wrapper = mount(ComposerInput, { attachTo: document.body })
    await flushPromises()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string, icon?: string) => void }
    vm.insertSlashChip('goal', 'terminal')
    await nextTick()
    const chip = wrapper.find('.slash-chip .chip-label')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('/goal')
  })

  it('U11b insertSlashChip("/commit") 已带 / 前缀 → 不重复补', async () => {
    wrapper = mount(ComposerInput, { attachTo: document.body })
    await flushPromises()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string, icon?: string) => void }
    vm.insertSlashChip('/commit', 'terminal')
    await nextTick()
    const chip = wrapper.find('.slash-chip .chip-label')
    expect(chip.text()).toBe('/commit')
  })
})
