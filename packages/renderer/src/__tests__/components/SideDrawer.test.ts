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

// ── mock useSessionEvents：捕获 onMessage 注册的 handler，并模拟 sid 切换退订 ──
// 对齐真实 useSessionEvents 语义：watch(sessionId) 切换时退订旧 sid、订新 sid。
// 本 mock 用「当前活跃 sid」过滤：只有当前 sid 的 handler 会被 emitTo 触发，
// 旧 sid 的 handler 在切走后不再响应（模拟退订）。
// vi.mock 工厂被提升到文件顶部，必须用 vi.hoisted 声明共享状态，否则 ReferenceError
const mockState = vi.hoisted(() => ({
  allRegistrations: [] as Array<{ sid: string; type: string; handler: (msg: unknown) => void }>,
  subscribeOrder: [] as string[],
  activeSid: null as string | null,
}))

vi.mock('@/composables/features/useSessionEvents', () => ({
  useSessionEvents: (sidRef: { value: string | null }) => {
    // 跟踪当前活跃 sid（对齐真实 watch(sessionId) 行为）
    mockState.activeSid = sidRef.value
    return (type: string, handler: (msg: unknown) => void) => {
      const sid = sidRef.value
      if (sid == null) return
      mockState.subscribeOrder.push(`${sid}:${type}`)
      mockState.allRegistrations.push({ sid, type, handler })
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

/** 向某 sid 的某 type 推送消息（仅触发该 sid 且仍为活跃 sid 的 handler，模拟退订） */
function emitTo(sid: string, type: string, msg: ServerMessage): void {
  // 模拟 useSessionEvents 退订：只有当前活跃 sid 的 handler 响应
  if (mockState.activeSid !== sid) return
  for (const entry of mockState.allRegistrations) {
    if (entry.sid === sid && entry.type === type) {
      entry.handler(msg)
    }
  }
}

/** 不经退订过滤，直接向指定 sid 的所有 handler 推送（模拟迟到事件/竞态窗口） */
function emitRaw(sid: string, type: string, msg: ServerMessage): void {
  for (const entry of mockState.allRegistrations) {
    if (entry.sid === sid && entry.type === type) {
      entry.handler(msg)
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
    mockState.allRegistrations.length = 0
    mockState.subscribeOrder.length = 0
    mockState.activeSid = null
  })

  it('terminal widget 推送按 sid 路由，切换 activeTab 后渲染对应 sid 的缓冲', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('terminal', ['a-line-1', 'a-line-2']))
    await nextTick()

    // terminal tab 渲染 a 的 lines
    const codeEls = wrapper.findAll('code')
    expect(codeEls.length).toBe(2)
    expect(codeEls[0].text()).toBe('a-line-1')

    wrapper.unmount()
  })

  it('AC-4: session A 有 terminal 缓冲，切到 B 后 B 不显示 A 的缓冲', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('terminal', ['a-content']))
    await nextTick()
    expect(wrapper.findAll('code').length).toBe(1)

    // 同一组件实例切到 B
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()

    // B 没有 widget 推送时，terminal tab 应是空态（不显示 A 的 'a-content'）
    const codes = wrapper.findAll('code')
    expect(codes.length).toBe(0)
    // A 的缓冲不应残留到 B 的渲染（空态文案存在）
    expect(wrapper.text()).not.toContain('a-content')

    wrapper.unmount()
  })

  it('AC-4: 切回 A 后 A 的 terminal 缓冲恢复显示', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()
    emitTo(SID_A, 'extension:widget', mkWidgetMsg('terminal', ['a-persistent']))
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

  it('AC-4: browser 缓冲与 terminal 缓冲各自独立隔离', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()

    emitTo(SID_A, 'extension:widget', mkWidgetMsg('terminal', ['t-content']))
    emitTo(SID_A, 'extension:widget', mkWidgetMsg('browser', ['b-content']))
    await nextTick()

    // 切到 B 再切回 A，两种缓冲都应保留
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()
    await wrapper.setProps({ sessionId: SID_A })
    await flushPromises()

    // 切到 browser tab：应显示 b-content
    await wrapper.setProps({ activeTab: 'browser' })
    await nextTick()
    const browserCodes = wrapper.findAll('code')
    expect(browserCodes.some((c) => c.text() === 'b-content')).toBe(true)

    // 切回 terminal tab：应显示 t-content
    await wrapper.setProps({ activeTab: 'terminal' })
    await nextTick()
    const termCodes = wrapper.findAll('code')
    expect(termCodes.some((c) => c.text() === 't-content')).toBe(true)

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
    mockState.allRegistrations.length = 0
    mockState.subscribeOrder.length = 0
    mockState.activeSid = null
  })

  it('切到 B 后，向 A 推送的事件不写入 B 的缓冲分区', async () => {
    const wrapper = mountDrawer(SID_A, 'terminal')
    await flushPromises()

    // 切到 B
    await wrapper.setProps({ sessionId: SID_B })
    await flushPromises()

    // 模拟退订后 A 的迟到事件（emitRaw 绕过退订过滤，模拟竞态窗口内的事件）
    // W4 后：useSessionEvents 已退订 A，且 Map 分区已切到 B，A 的 handler 不再写入当前分区
    // 当前实现：handler 闭包写组件级 ref，切 sid 后 A 迟到事件仍污染 B 的显示 → 红灯
    emitRaw(SID_A, 'extension:widget', mkWidgetMsg('terminal', ['late-from-A']))
    await nextTick()

    // B 的 terminal tab 不应渲染 A 迟到的内容
    const codes = wrapper.findAll('code')
    expect(codes.some((c) => c.text() === 'late-from-A')).toBe(false)

    wrapper.unmount()
  })

  it('切到 B 后向 B 推送的事件正确写入 B 缓冲（正向对照）', async () => {
    const wrapper = mountDrawer(SID_B, 'terminal')
    await flushPromises()

    emitTo(SID_B, 'extension:widget', mkWidgetMsg('terminal', ['b-fresh']))
    await nextTick()

    const codes = wrapper.findAll('code')
    expect(codes.some((c) => c.text() === 'b-fresh')).toBe(true)

    wrapper.unmount()
  })
})
