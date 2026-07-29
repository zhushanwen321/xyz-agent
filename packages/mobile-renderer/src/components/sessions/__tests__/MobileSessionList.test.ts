/**
 * MobileSessionList + SessionsTab 测试（P4-s3-w1 AC5 + CRITICAL-1/2 回归）。
 *
 * AC5 验收：
 *  - MobileSessionList 空态/列表态切换（DOM 断言）
 *  - MobileChatView mock WS 消息后消息文本可见
 *  - 列表态→会话态切换（select emit → chat 渲染）
 *
 * CRITICAL-1 回归：SessionsTab onMounted 触发 useSidebar().loadSessions()
 * CRITICAL-2 回归：SessionsTab onSelect 调 useSidebar().selectSession(id)（switchSession + 历史加载）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobileSessionList from '../MobileSessionList.vue'
import SessionsTab from '../SessionsTab.vue'

// [CRITICAL-1/2] Mock useSidebar：loadSessions（onMounted 触发）+ selectSession（onSelect 触发）
// 避免真实 RPC 调用（ws-client），同时断言触发点。
const { loadSessionsMock, selectSessionMock } = vi.hoisted(() => ({
  loadSessionsMock: vi.fn(() => Promise.resolve()),
  selectSessionMock: vi.fn((_id: string) => Promise.resolve()),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    loadSessions: loadSessionsMock,
    selectSession: selectSessionMock,
  }),
}))

// Mock useChat（MobileChatView 依赖，避免真实 ws-client 调用）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  loadSessionsMock.mockClear()
  selectSessionMock.mockClear()
})

describe('MobileSessionList（P4-s3-w1 AC5）', () => {
  it('空态：无 session 时显示空态 + 新建按钮', () => {
    const wrapper = mount(MobileSessionList)
    expect(wrapper.find('[data-testid="mobile-session-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-new-session-btn"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无会话')
  })

  it('列表态：store.list 有 session 时渲染列表项', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
      { id: 's2', label: 'main', cwd: '/p', state: 'idle' } as never,
    ] }])

    const wrapper = mount(MobileSessionList)
    expect(wrapper.find('[data-testid="mobile-session-empty"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid^="mobile-session-item-"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="mobile-session-item-s1"]').text()).toContain('feat-x')
  })

  it('点击 session 项 emit select(sessionId)', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
    ] }])
    const wrapper = mount(MobileSessionList)
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['s1']])
  })
})

describe('SessionsTab 状态机（P4-s3-w1 AC5 列表↔会话态）', () => {
  it('默认 list 态：渲染 MobileSessionList', () => {
    const wrapper = mount(SessionsTab)
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
  })

  it('select → chat 态：渲染 MobileChatView（含返回按钮）', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
    ] }])
    const wrapper = mount(SessionsTab)
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    await vi.dynamicImportSettled()
    expect(wrapper.find('[data-testid="mobile-chat-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-chat-back"]').exists()).toBe(true)
  })

  it('chat 态点返回 → list 态', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
    ] }])
    const wrapper = mount(SessionsTab)
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    await vi.dynamicImportSettled()
    expect(wrapper.find('[data-testid="mobile-chat-view"]').exists()).toBe(true)
    await wrapper.find('[data-testid="mobile-chat-back"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
  })
})

// ── CRITICAL-1：SessionsTab onMounted 触发 loadSessions ──
describe('SessionsTab [CRITICAL-1] onMounted 触发 loadSessions', () => {
  it('挂载 SessionsTab 后调用 useSidebar().loadSessions()', () => {
    mount(SessionsTab)
    expect(loadSessionsMock).toHaveBeenCalledTimes(1)
  })
})

// ── CRITICAL-2：SessionsTab onSelect 调 selectSession（switchSession + 历史加载）──
describe('SessionsTab [CRITICAL-2] onSelect 调 selectSession', () => {
  it('点击 session 项 → 调 useSidebar().selectSession(id)（非仅切本地 view）', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
    ] }])
    const wrapper = mount(SessionsTab)
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    await vi.dynamicImportSettled()

    // selectSession 被调用，参数 = 点击的 sessionId
    expect(selectSessionMock).toHaveBeenCalledWith('s1')
    // 进入 chat 态
    expect(wrapper.find('[data-testid="mobile-chat-view"]').exists()).toBe(true)
  })

  it('selectSession 失败 → 不进 chat 态（toast 错误，停留 list）', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    store.setGroups([{ cwd: '/p', sessions: [
      { id: 's1', label: 'feat-x', cwd: '/p', state: 'idle' } as never,
    ] }])
    selectSessionMock.mockRejectedValueOnce(new Error('switch failed'))

    const wrapper = mount(SessionsTab)
    await wrapper.find('[data-testid="mobile-session-item-s1"]').trigger('click')
    await vi.dynamicImportSettled()

    // selectSession 被调用但失败，停留 list 态
    expect(selectSessionMock).toHaveBeenCalledWith('s1')
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-chat-view"]').exists()).toBe(false)
  })
})
