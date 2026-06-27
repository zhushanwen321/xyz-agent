/**
 * Landing 组件 + Panel landing 分支单测（#2，T1.6/T1.7/T1.8）。
 *
 * 覆盖：
 * - T1.6 messageCount===0 && !isGenerating → 渲染 landing（Panel v-if 分支）
 * - T1.7 messages 空但 isGenerating=true → 不渲染 landing（生成态优先）
 * - T1.8 getHistory 失败 → landing 有重试按钮，点击 emit retry 不永久卡住
 *
 * mock 策略：
 * - Landing 直挂载（presentational，props/emits），无 store 依赖。
 * - Panel v-if 条件：mount Panel（子组件 stub）+ 真 pinia chat store，操控 messages/isStreaming。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/landing.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Landing from '@/components/new-task/Landing.vue'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import type { DerivedStatus } from '@/types'

// Landing 绑定 useNewTaskFlow（chip→popover 渲染绑定 #5/#6）。mock 捕获方法调用
const flowMock = vi.hoisted(() => ({
  // landing 态 session/cwd/branch 真源 computed refs（landing.vue 的 composerSid/cwd/branch 依赖）
  currentSessionId: { value: null as string | null },
  currentCwd: { value: null as string | null },
  gitInfo: { value: null as { branch: string } | null },
  openDirPopover: vi.fn(),
  openBranchPopover: vi.fn(),
  closeOverlay: vi.fn(),
  selectWorkspace: vi.fn(),
  selectBranch: vi.fn(),
  confirmDirtySwitch: vi.fn(),
  openDirDialog: vi.fn(),
  openBranchModal: vi.fn(),
  state: { value: 'idle' as string },
}))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMock,
  resetNewTaskFlow: vi.fn(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

const DONE = 'done' as DerivedStatus

/** mount Panel 时 stub 掉所有重子组件，只验 landing v-if 分支 */
const panelStubs = {
  PanelHeader: { template: '<div />' },
  ProgressZone: { template: '<div />' },
  MessageStream: { template: '<div />' },
  Composer: { template: '<div />' },
  GitZone: { template: '<div />' },
  SideDrawer: { template: '<div />' },
}

/** Landing 现内嵌 Composer 卡片，directory/branch chip 在 Composer 的 #meta-row slot 内。
 *  mount(Landing) 若渲染真实 Composer 会触发其重依赖（useChat/useChatStore/多个 Popover）崩溃。
 *  解法：stub Composer 为「渲染 meta-row slot」的空壳——chip 仍进 DOM 可查（点 chip 测试依赖），
 *  Composer 内部逻辑不在此测（首屏冒烟 landing-smoke.test.ts 才验真实 composer）。 */
const landingStubs = {
  Composer: { template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>' },
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(Panel, {
    props: {
      panelId: 'p1',
      sessionId: 's1',
      sessionLabel: 'label',
      sessionDir: '/repo',
      status: DONE,
      active: true,
      isDual: false,
      ...overrides,
    },
    global: { stubs: panelStubs },
  })
}

describe('Landing 渲染条件（Panel v-if 分支）', () => {
  it('T1.6 messageCount===0 && !isGenerating → 渲染 landing', () => {
    const chat = useChatStore()
    chat.isStreaming = false // !isGenerating
    // session 's1' 未 hydrate → getMessages 返回 [] → messageCount=0
    const wrapper = mountPanel({ sessionId: 's1' })
    expect(wrapper.findComponent(Landing).exists()).toBe(true)
  })

  it('T1.7 messages 空但 isGenerating=true → 不渲染 landing（生成态优先）', () => {
    const chat = useChatStore()
    chat.isStreaming = true // isGenerating
    const wrapper = mountPanel({ sessionId: 's1' })
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
  })

  it('T1.6 有消息（messageCount>0）→ 不渲染 landing（走对话流）', () => {
    const chat = useChatStore()
    chat.isStreaming = false
    chat.hydrate('s1', [
      { id: 'm1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
    ])
    const wrapper = mountPanel({ sessionId: 's1' })
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
  })
})

describe('Landing 组件（presentational）', () => {
  it('渲染问候语 + directory chip（T1.6 landing 内容）', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    expect(wrapper.text()).toContain('有什么想让我帮忙的吗')
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-branch"]').exists()).toBe(true)
  })

  it('gitBranch 为空 → branch chip 隐藏（UC-7 非 git 目录，AC-2.2）', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/plain' },
      global: { stubs: landingStubs },
    })
    expect(wrapper.find('[data-testid="chip-branch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
  })

  it('currentCwd 为空（首次启动延迟 create）→ directory chip 显空态文案', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: null },
      global: { stubs: landingStubs },
    })
    const chip = wrapper.find('[data-testid="chip-directory"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('选择目录')
  })

  it('点 directory chip → 调 useNewTaskFlow.openDirPopover（#5 渲染绑定）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    await wrapper.find('[data-testid="chip-directory"]').trigger('click')
    expect(flowMock.openDirPopover).toHaveBeenCalled()
  })

  it('点 branch chip → 调 useNewTaskFlow.openBranchPopover（#6 渲染绑定）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    await wrapper.find('[data-testid="chip-branch"]').trigger('click')
    expect(flowMock.openBranchPopover).toHaveBeenCalled()
  })
})

describe('Landing getHistory 失败重试（T1.8）', () => {
  it('historyError=true → 渲染重试按钮，点击 emit retry（不永久卡住）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', historyError: true },
      global: { stubs: landingStubs },
    })
    const retry = wrapper.find('[data-testid="retry-history"]')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toBeTruthy()
  })

  it('historyError=false → 不渲染重试按钮', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', historyError: false },
      global: { stubs: landingStubs },
    })
    expect(wrapper.find('[data-testid="retry-history"]').exists()).toBe(false)
  })
})
