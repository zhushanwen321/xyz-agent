/**
 * MessageStream kind 查表分发测试（renderer-model 归一 M1 TC2）。
 *
 * 验证：RenderItem.kind 全集（turn/systemNotice/bashExecution）在 MessageStream 模板
 * 按 kind → 组件纯查表分发（conversation-renderer-model-unification §3.3.1）：
 * - kind==='turn'          → Turn
 * - kind==='bashExecution' → BashOutputBlock
 * - 其余（systemNotice）   → SystemNotice
 *
 * 死分支回归防护：bgNotify / gui 渲染分支已随 M1 删除（BgNotifyCard 组件本体 M2、
 * Message.bgNotify 字段与 extractGuiComponent 函数 M6 删除）——kind 全集不含这两类，
 * 若未来有人加回「嗅探 details.__gui__ / bgNotify 字段再渲染专属卡片」的路径，
 * 本测通过「kind 全集三态互斥 + 无 bgNotify/gui 渲染」抓出。
 *
 * 为什么 mock virtua/vue：happy-dom 无真实布局/ResizeObserver，真 <Virtualizer> 的
 * viewportSize=0 → 不窗口化渲染任何项（MessageStream-bash.test.ts T10/gap3 因同因 skip）。
 * 本测把 Virtualizer mock 成全量渲染 scoped slot 的 stub，让模板 v-if/v-else-if/v-else
 * 链对每项真实执行——这正是「查表分发」的断言对象（组件选中逻辑在模板，不在 virta）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-kind.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import type { Message } from '@xyz-agent/shared'

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub ──────────────────────────
// 暴露 VirtualizerHandle 兼容字段（MessageStream 的 vlistBottom/rail/useVirtuaFollow
// 在 mount 期读取 scrollSize/findItemIndex/getItemOffset 等；vi.fn 保证不会调崩）。
// 注意 1：vi.mock factory 会被 hoist 到文件顶部，不能引用顶层变量——vue/vi 全部动态 import。
// 注意 2：defineExpose 是 <script setup> 编译宏，普通 setup 函数里调用不生效（实测）。
//   mock 改由 setup 返回 handle 对象（自动成为 setupState，proxy 可读）+ render 选项渲染 slot。
// [M5 stable-key] slotKeyCollector：mock render 时记录每个 item 的 slot vnode key——
//    virtua 生产实现用 slot vnode 的 key 作 item key（无 key 时 fallback `_${index}`，
//    消息插删时按索引错位复用 DOM）。收集器用于断言 slot 三分支已绑定稳定 :key。
const slotKeyCollector = vi.hoisted(() => ({ keys: [] as (string | number | symbol | null | undefined)[][] }))

vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
      },
      setup() {
        // setup 返回对象 → 键暴露在 public instance proxy（模板 ref 指向它），
        // MessageStream 经 vlistRef.value.scrollSize/findItemIndex 等读取（vlistBottom 等）。
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        return h(
          'div',
          { class: 'mock-virtualizer' },
          (ctx.data as unknown[]).map((item, index) => {
            const vnodes = ctx.$slots.default?.({ item, index }) ?? []
            slotKeyCollector.keys.push(vnodes.map((v) => v.key))
            return vnodes
          }),
        )
      },
    }),
  }
})

// 壳 deps mock（MessageStream 装配 useChatViewDeps，测试聚焦 kind 分发不需真 deps）
const chatDepsMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => []),
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
  toggleExpand: vi.fn(),
  collapse: vi.fn(),
  abortBash: vi.fn(),
  editAndResend: vi.fn(),
  onFork: vi.fn(),
  onForkAsk: vi.fn(),
  onHandoff: vi.fn(),
  onHandoffAsk: vi.fn(),
  openDrawer: vi.fn(),
  onFileClick: vi.fn(),
  onAmbiguousSelect: vi.fn(),
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}))
vi.mock('@/composables/panel/useChatViewDeps', () => ({
  useChatViewDeps: () => chatDepsMock,
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** 目标组件 stub：带 testid，断言「kind → 组件」选中关系（选中哪个就渲染哪个 testid）。 */
const globalStubs = {
  Turn: {
    name: 'Turn',
    props: { turn: { type: Object, required: true } },
    template: '<div :data-testid="`turn-stub-${turn.index}`" />',
  },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'system',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

function bashMsg(id: string): Message {
  return makeMsg({
    id,
    role: 'system',
    bashExecution: {
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1000,
    },
  })
}

describe('MessageStream kind 查表分发（M1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    slotKeyCollector.keys.length = 0
  })

  it('TC2: kind=bashExecution → BashOutputBlock，SystemNotice/Turn 不渲染', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-bash', [bashMsg('bash-1')])

    const wrapper = mountStream('sess-kind-bash')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="turn-stub-"]').exists()).toBe(false)
  })

  it('TC2: kind=systemNotice（compaction/branchSummary 等无 bashExecution 的 system）→ SystemNotice', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-notice', [
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'b1', branchSummary: { summary: 's', fromId: 'prev' } }),
    ])

    const wrapper = mountStream('sess-kind-notice')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid="system-notice-stub"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="turn-stub-"]').exists()).toBe(false)
  })

  it('TC2: kind=turn → Turn，system 类组件不渲染', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-turn', [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])

    const wrapper = mountStream('sess-kind-turn')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
  })

  it('TC2: 混合序列 [turn, systemNotice, turn, bashExecution] 按序渲染，各分支互斥', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-mix', [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ])

    const wrapper = mountStream('sess-kind-mix')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid^="turn-stub-"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(true)

    // DOM 顺序与 renderItems 一致：turn1 → notice → turn2 → bash
    const body = wrapper.element as HTMLElement
    const ids = Array.from(body.querySelectorAll('[data-testid^="turn-stub-"], [data-testid="system-notice-stub"], [data-testid="bash-output-stub"]')).map(
      (el) => el.getAttribute('data-testid'),
    )
    expect(ids).toEqual(['turn-stub-1', 'system-notice-stub', 'turn-stub-2', 'bash-output-stub'])
  })

  it('TC2: bgNotify 消息（customType=subagent-bg-notify, display:false）不渲染任何专属组件（M1 死分支回归防护）', async () => {
    // [M2 display 前置] 黑名单已删：subagent-bg-notify 由生产端（registry customStart /
    // runtime mapper）统一写 display:false → filterDisplayableMessages 按 display 字段过滤移除。
    // 若未来有人给 kind 全集加回 bgNotify 类分支/嗅探，本用例确保至少不渲染专属卡片。
    const chat = useChatStore()
    chat.hydrate('sess-kind-bgnotify', [
      makeMsg({ id: 'n1', customType: 'subagent-bg-notify', display: false, content: '子代理完成' }),
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])

    const wrapper = mountStream('sess-kind-bgnotify')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 过滤后只剩 user+assistant → 1 个 turn；bg-notify 消息不产生任何渲染项
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
  })

  it('TC2: slot vnode 带稳定 :key（renderKey(item)，非索引——virtua item key 依据）', async () => {
    // [M5 stable-key] virtua 生产实现：slot 返回单 vnode 时取其 key 作 item key，
    // 无 key 时 fallback `_${index}`（消息插删/streaming 追加按索引错位复用 DOM）。
    // 断言：每个 item 的 slot vnode key 存在且为稳定 id 派生（turn=首条消息 id，system=message.id），
    // 且同一数据两次渲染 key 集合一致（不随渲染重建漂移）。
    const chat = useChatStore()
    chat.hydrate('sess-kind-key', [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ])

    const wrapper = mountStream('sess-kind-key')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 4 个渲染项（turn1 + notice + turn2 + bash），每个 slot vnode 都带 key
    expect(slotKeyCollector.keys).toHaveLength(4)
    const flatKeys = slotKeyCollector.keys.map((k) => k[0])
    expect(flatKeys).toEqual(['t-u1', 's-c1', 't-u2', 's-bash-1'])
    // 全部 key 非空（virtua 不会 fallback `_${index}`）
    expect(flatKeys.every((k) => k != null && k !== '')).toBe(true)

    // 同一数据重新 mount → key 集合一致（不随渲染重建漂移）
    slotKeyCollector.keys.length = 0
    const wrapper2 = mountStream('sess-kind-key')
    await wrapper2.vm.$nextTick()
    await wrapper2.vm.$nextTick()
    expect(slotKeyCollector.keys.map((k) => k[0])).toEqual(['t-u1', 's-c1', 't-u2', 's-bash-1'])
    wrapper2.unmount()
  })
})
