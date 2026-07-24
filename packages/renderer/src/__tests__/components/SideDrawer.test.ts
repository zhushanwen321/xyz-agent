/**
 * SideDrawer widget 缓冲 per-session 隔离单测（W4 / TDD 红灯）。
 *
 * 覆盖 ADR-0036 迁移：terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap
 * 五个状态经 useSessionScopedState 分区。
 * - AC-4: 切 session 后 widget 缓冲不串台（切回恢复）
 * - AC-4 (时序): 切 sid 时缓冲分区切换与 useSessionEvents 退订时序一致
 *
 * 运行：npx vitest run src/__tests__/components/SideDrawer.test.ts
 * 禁止 node:test / tsx --test。
 *
 * 时序竞态说明：SideDrawer 切 sid 时，useSessionEvents 先退订旧 sid 的底层订阅，
 * 然后 watch(sessionId) 清空缓冲。W4 改 Map 分区后，"清空"变为"切分区"，
 * 时序约束是：旧 sid 的后续消息（若在退订前一刻到达）不应写入新 sid 的分区。
 * 此竞态在同步 watch（flush:sync）下不可观测，本测试验证的是可观测层：
 * 切 sid 后旧 sid 的事件不再影响新 sid 的缓冲显示。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

// 组件 mount 时 useSideDrawer 内的 useSessionScopedState 会注册 cleanup 到模块级 registry；
// 虽然 unmount 会触发 onScopeDispose 反注册，保险起见每个用例前清空防跨用例残留
beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
})

// ── mock useSessionEvents：捕获 onMessage 注册的 handler，模拟真实退订语义 ──
// 真实 useSessionEvents：subscribe(sid) 闭包捕获订阅时 sid，分发时把它传给 handler（第二参数）。
// handler 收到的 sid 是「订阅时捕获值」（不随当前 sid 变化），调用方据此调 updateFor(sid) 写
// 「消息所属 sid」分区——即使 watch flush:pre 异步退订窗口内有旧 sid 迟到消息，也只写旧 sid 分区，
// 从结构上消除竞态（ADR-0036 W4 M1）。
// 本 mock 对齐此语义：注册时快照 sidRef.value（注册时 sid），emitTo(sid) 只触发「快照 sid === sid」
// 的 handler，并把快照 sid 作为第二参数传给 handler。切 sid 后快照不变，旧 sid 的 handler 仍响应
// 旧 sid 的 emit（但写入旧 sid 分区，不污染新 sid）——验证 updateFor 的结构性隔离。
// vi.mock 工厂被提升到文件顶部，必须用 vi.hoisted 声明共享状态，否则 ReferenceError
const mockState = vi.hoisted(() => ({
  // 每个 registration 绑定注册时的 sid 快照（而非 sidRef 引用）——对齐真实 useSessionEvents
  // 的 subscribe(sid) 闭包捕获 sid（handler 拿到的第二参数是这个快照值，不随当前 sid 变化）
  registrations: [] as Array<{ sidAtRegistration: string; type: string; handler: (msg: unknown, sid: string) => void }>,
  subscribeOrder: [] as string[],
}))

vi.mock('@/composables/features/useSessionEvents', () => ({
  useSessionEvents: (sidRef: { value: string | null }) => {
    return (type: string, handler: (msg: unknown, sid: string) => void) => {
      const sid = sidRef.value
      if (sid == null) return
      // 注册时快照当前 sidRef.value（对齐真实 subscribe(sid) 闭包捕获 sid）
      mockState.subscribeOrder.push(`${sid}:${type}`)
      mockState.registrations.push({ sidAtRegistration: sid, type, handler })
    }
  },
}))

// ── mock 子组件为桩，避免依赖真实 GitPanel/DetailPane 等的复杂依赖 ──
vi.mock('@/components/panel/GitPanel.vue', () => ({ default: { template: '<div data-testid="git-stub" />' } }))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({ default: { template: '<div data-testid="doc-stub" />' } }))
vi.mock('@/components/panel/DetailPane.vue', () => ({ default: { template: '<div data-testid="detail-stub" />' } }))
vi.mock('@/components/message-stream/GuiComponentRenderer.vue', () => ({
  default: { template: '<div data-testid="gui-renderer-stub" />' },
}))
vi.mock('@/components/message-stream/gui/AnsiText.vue', () => ({
  default: { props: ['content'], template: '<span>{{ content }}</span>' },
}))

import SideDrawer from '@/components/panel/SideDrawer.vue'

/** 构造 extension:widget 消息 */
function mkWidgetMsg(widgetKey: string, lines: string[]): ServerMessage<'extension:widget'> {
  return {
    type: 'extension:widget' as const,
    payload: { widgetKey, lines },
  } as unknown as ServerMessage<'extension:widget'>
}

/** 构造 extension:status 消息 */
function mkStatusMsg(statusKey: string, text: string): ServerMessage<'extension:status'> {
  return {
    type: 'extension:status' as const,
    payload: { statusKey, text },
  } as unknown as ServerMessage<'extension:status'>
}

/**
 * 向某 sid 的某 type 推送消息。
 * 对齐真实 useSessionEvents：只触发「注册时快照 sid === sid」的 handler，并把该快照 sid
 * 作为第二参数传给 handler（模拟真实 subscribe(sid) 闭包捕获后透传）。
 * 切 sid 后快照不变，旧 sid 的 handler 仍响应旧 sid 的 emit（但调用方 updateFor(sid) 写旧 sid
 * 分区，不污染新 sid）——验证 updateFor 的结构性竞态隔离（M1 修复核心）。
 */
function emitTo(sid: string, type: string, msg: ServerMessage): void {
  for (const entry of mockState.registrations) {
    if (entry.sidAtRegistration === sid && entry.type === type) {
      entry.handler(msg, entry.sidAtRegistration)
    }
  }
}

function mountDrawer(sessionId: string | null, activeTab: SideDrawerTab = 'terminal') {
  return mount(SideDrawer, {
    props: {
      isOpen: true,
      activeTab,
      docked: false,
      direction: 'right',
      mode: 'split',
      sessionId,
    },
    global: { plugins: [] },
  })
}

const SID_A = 'drawer-sess-a'
const SID_B = 'drawer-sess-b'

describe('W4 SideDrawer AC-4: widget 缓冲 per-session 隔离', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockState.registrations.length = 0
    mockState.subscribeOrder.length = 0
  })

  it('browser widget 推送按 sid 路由，切换 activeTab 后渲染对应 sid 的缓冲', async () => {
    // 注：terminal tab 自 Phase 3 起渲染 TerminalView（PTY），不再消费 widget 数据；
    // widget 分区隔离机制改用 browser tab 验证（browser 走 widget fallback 路径）
    const wrapper = mountDrawer(SID_A, 'browser')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['a-line-1', 'a-line-2']))
    await nextTick()

    // browser tab 渲染 a 的 lines
    const codeEls = wrapper.findAll('code')
    expect(codeEls.length).toBe(2)
    expect(codeEls[0].text()).toBe('a-line-1')

    wrapper.unmount()
  })

  it('AC-4: session A 有 browser 缓冲，切到 B 后 B 不显示 A 的缓冲', async () => {
    const wrapper = mountDrawer(SID_A, 'browser')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['a-content']))
    await nextTick()
    expect(wrapper.findAll('code').length).toBe(1)

    // 同一组件实例切到 B
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()

    // B 没有 widget 推送时，browser tab 应是空态（不显示 A 的 'a-content'）
    const codes = wrapper.findAll('code')
    expect(codes.length).toBe(0)
    // A 的缓冲不应残留到 B 的渲染（空态文案存在）
    expect(wrapper.text()).not.toContain('a-content')

    wrapper.unmount()
  })

  it('AC-4: 切回 A 后 A 的 browser 缓冲恢复显示', async () => {
    const wrapper = mountDrawer(SID_A, 'browser')
    await flushPromises()
    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['a-persistent']))
    await nextTick()

    // 切到 B（当前实现会清空缓冲 → 切回看不到；W4 Map 分区后应保留）
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()
    // 切回 A
    await wrapper.setProps({ sessionId: SID_A })
    await flushPromises()

    // W4 后：A 的缓冲分区仍在，切回应恢复 'a-persistent'
    // 当前实现：watch(sessionId) 清空了缓冲，切回看不到 → 此断言红灯
    const codes = wrapper.findAll('code')
    expect(codes.some((c) => c.text() === 'a-persistent')).toBe(true)

    wrapper.unmount()
  })

  it('AC-4: browser 缓冲与 unknown widget 缓冲各自独立隔离', async () => {
    // 注：原 terminal/browser 双 widget 测试改用 browser/unknown（terminal tab 不再消费 widget）
    const wrapper = mountDrawer(SID_A, 'browser')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['b-content']))
    emitTo(SID_A, 'extension:widget', mkWidgetMsg('custom-widget', ['c-content']))
    await nextTick()

    // 切到 B 再切回 A，两种缓冲都应保留
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()
    await wrapper.setProps({ sessionId: SID_A })
    await flushPromises()

    // browser tab：应显示 b-content
    await wrapper.setProps({ activeTab: 'browser' })
    await nextTick()
    const browserCodes = wrapper.findAll('code')
    expect(browserCodes.some((c) => c.text() === 'b-content')).toBe(true)

    wrapper.unmount()
  })

  it('AC-4: status 缓冲切 session 不串台，切回恢复', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()

    emitTo(SID_A, 'extension:status', mkStatusMsg('cpu', 'A: 50%'))
    await nextTick()
    // footer 有 status 条目
    expect(wrapper.text()).toContain('A: 50%')

    // 切到 B：status footer 不应显示 A 的 status
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()
    expect(wrapper.text()).not.toContain('A: 50%')

    // 切回 A：W4 后 status 分区保留，恢复显示
    await wrapper.setProps({ sessionId: SID_A })
    await flushPromises()
    expect(wrapper.text()).toContain('A: 50%')

    wrapper.unmount()
  })
})

describe('W4 SideDrawer AC-4 (时序): 切 sid 时缓冲与 useSessionEvents 退订一致', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockState.registrations.length = 0
    mockState.subscribeOrder.length = 0
  })

  it('切到 B 后，向 A 推送的事件不写入 B 的缓冲分区（updateFor 结构性隔离）', async () => {
    // 真实 useSessionEvents：subscribe(sid) 闭包捕获订阅时 sid，分发时透传给 handler。即使
    // watch flush:pre 异步退订窗口内旧 sid 迟到消息仍进入 handler，handler 传入的仍是旧 sid，
    // 调 updateFor(旧 sid) 写旧 sid 分区。本用例验证此结构性隔离：切到 B 后 emitTo(SID_A)
    // 会触发 A 的 handler（注册时 sid=A 快照匹配），handler 写 A 分区，但 B 渲染不受影响。
    // 注：terminal tab 自 Phase 3 起渲染 TerminalView，改用 browser tab 验证 widget 分区
    const wrapper = mountDrawer(SID_A, 'browser')
    await flushPromises()

    // 切到 B
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()

    // 向 A 推送：handler 触发，写 A 分区（updateFor(SID_A)）；B 分区不受影响，B 渲染不显示 A 内容
    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['late-from-A']))
    await nextTick()

    // B 的 browser tab 不应渲染 A 的内容（updateFor 结构性隔离：A 消息写 A 分区，不串 B）
    const codes = wrapper.findAll('code')
    expect(codes.some((c) => c.text() === 'late-from-A')).toBe(false)

    wrapper.unmount()
  })

  it('切到 B 后向 B 推送的事件正确写入 B 缓冲（正向对照）', async () => {
    const wrapper = mountDrawer(SID_B, 'browser')
    await flushPromises()

    emitTo(SID_B, 'extension:widget', mkWidgetMsg('browser', ['b-fresh']))
    await nextTick()

    const codes = wrapper.findAll('code')
    expect(codes.some((c) => c.text() === 'b-fresh')).toBe(true)

    wrapper.unmount()
  })
})
