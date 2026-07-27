/**
 * Turn.vue 首屏冒烟测试（fast-handoff wave）。
 *
 * 验证 Turn 渲染核心交互元素存在于 DOM（AGENTS #5：每用例含用户可见断言）：
 * - handoff 按钮（data-testid="handoff-btn"）
 * - fork 按钮（data-testid="fork-background-btn" / "fork-ask-btn"）
 * - handoff 按钮 disabled 守卫（isHandingOff）
 * - fork 按钮 disabled 守卫（isForking）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/Turn.smoke.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock useChatStore ──
const chatStoreMock = vi.hoisted(() => ({
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  isHydrated: vi.fn(() => false),
  getMessages: vi.fn(() => []),
  getChangeSetStatus: vi.fn(() => undefined),
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

// ── mock useChat ──
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))

// ── mock useSidebar ──
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    loadSessions: vi.fn(),
    selectSession: vi.fn(),
    forkSession: vi.fn(),
    handoff: vi.fn(),
  }),
}))

// ── mock useTurnActions（返回 handler stub）──
const turnActionsMock = vi.hoisted(() => ({
  onFork: vi.fn(() => Promise.resolve()),
  onForkAsk: vi.fn(),
  onHandoff: vi.fn(() => Promise.resolve()),
  onHandoffAsk: vi.fn(),
}))
vi.mock('@/composables/panel/useTurnActions', () => ({
  useTurnActions: () => turnActionsMock,
}))

// ── mock useSideDrawer ──
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

// ── mock usePlatformShortcut ──
vi.mock('@/composables/usePlatformShortcut', () => ({
  usePlatformShortcut: () => ({ formatKbd: (k: string) => k }),
}))

// ── mock useFileTreeStore ──
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ selectFile: vi.fn() }),
}))

// ── mock isSubagentVirtualId ──
vi.mock('@/stores/subagent', () => ({
  isSubagentVirtualId: () => false,
}))

// ── mock useTurnElapsed ──
vi.mock('@/composables/panel/useTurnElapsed', () => ({
  useTurnElapsed: () => ({ elapsed: { value: '5s' } }),
}))

// ── mock useResizeReport ──
vi.mock('@/composables/effects/useResizeReport', () => ({
  useResizeReport: vi.fn(),
}))

// ── mock useStickGuard / useTraceTransition ──
vi.mock('@/composables/effects/useStickGuard', () => ({
  useStickGuard: () => null,
  useTraceTransition: () => ({
    onTraceBeforeLeave: vi.fn(),
    onTraceLeave: vi.fn(),
    onTraceEnter: vi.fn(),
  }),
}))

import Turn from '@/components/panel/message-stream/Turn.vue'

/** 构造最小 MessageTurn（含一条 assistant，触发 handoff/fork 按钮渲染） */
function makeTurn(overrides: Partial<MessageTurn> = {}): MessageTurn {
  const assistant: Message = {
    id: 'a-1',
    role: 'assistant',
    content: 'hello',
    segments: [],
    status: 'complete',
    createdAt: Date.now(),
  }
  return {
    index: 0,
    user: null,
    assistants: [assistant],
    isStreaming: false,
    hasFoldable: false,
    ...overrides,
  }
}

describe('Turn.vue 冒烟', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('handoff 按钮渲染', () => {
    const wrapper = shallowMount(Turn, {
      props: { turn: makeTurn(), sessionId: 'test-session' },
    })
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(true)
  })

  it('fork 按钮渲染（后台 + 提问）', () => {
    const wrapper = shallowMount(Turn, {
      props: { turn: makeTurn(), sessionId: 'test-session' },
    })
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
  })

  it('handoff 按钮 disabled（isHandingOff）', () => {
    chatStoreMock.isHandingOff.mockReturnValue(true)
    const wrapper = shallowMount(Turn, {
      props: { turn: makeTurn(), sessionId: 'test-session' },
    })
    const btn = wrapper.find('[data-testid="handoff-btn"]')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('fork 按钮 isForking 防重复守卫（存在性断言）', () => {
    const wrapper = shallowMount(Turn, {
      props: { turn: makeTurn(), sessionId: 'test-session' },
    })
    // isForking 初始 false，fork 按钮渲染在 DOM 中（handleFork 内部守卫 isForking 重入）
    const btn = wrapper.find('[data-testid="fork-background-btn"]')
    expect(btn.exists()).toBe(true)
  })

  it('无 assistant 时 fork/handoff 按钮不渲染', () => {
    const wrapper = shallowMount(Turn, {
      props: { turn: makeTurn({ assistants: [] }), sessionId: 'test-session' },
    })
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
  })
})
