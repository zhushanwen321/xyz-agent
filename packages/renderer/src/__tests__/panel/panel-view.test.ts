/**
 * Panel 渲染分支派生测试（panel-view switch 重写，单元 T3）。
 *
 * [权威] docs/design/panel-view-derivation-and-flow-lifecycle.md §3.3 D1/D2/D5：
 * Panel 主区与输入面判据收敛为 usePanelView → derivePanelView 单点派生，本文件锁
 * renderer 装配层的派生消费行为（core 纯函数的 64 组合表在
 * packages/core/src/domain/session/__tests__/panel-view.test.ts，V5）。
 *
 * 覆盖（每条至少一个用户可见 DOM 断言）：
 * - PV1 flow 残留免疫（G2 结构实证）：flow 活跃 + 有会话有消息 → 对话流 + Composer，
 *   Landing 不渲染（旧判据下此状态 turn 结束后 composer 消失——用户报告的原始 bug）
 * - PV2 landing：无 session + flow 活跃 → Landing；band 不重复挂 composer
 * - PV3 empty：绑定空会话（有 sid 无消息，flow idle）→ 空对话态 + Composer（直输）；
 *   无 session + flow idle → 选会话空态，无输入面
 * - PV4 dead：占位视图（重开入口），无 Composer；ask-user 请求在场仍无 overlay
 *   （W6「dead 不应答」由派生优先级 dead > ask-user 承接，收集侧不重复判）
 * - PV5 ask-user：请求到达 → AskUserOverlay 替换 Composer；应答出队 → Composer 恢复
 *
 * mock 策略：vi.hoisted 模块级可变对象（对齐 ask-user-inline.test.ts / landing.test.ts
 * 既有基建）——useExtensionUI（ask-user 请求队列）与 useNewTaskFlow（flow 单例态）
 * 可控；chat/session store 用真 pinia（消息 hydrate / markDead 走真实状态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import type { ExtensionUIRequest } from '@/api/domains/extension'
import type { SessionSummary } from '@xyz-agent/shared'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值（普通 { value } 等价 Ref） ──
const mockState = vi.hoisted(() => ({
  flowIsActive: { value: false as boolean },
}))

// ask-user 请求用真 Vue ref（async 工厂内建，测试经 __mockAskUserReq 拿同一引用）：
// PV5「应答出队 → Composer 恢复」断言挂载后的响应式更新，普通对象不建依赖不触发重算。
vi.mock('@/composables/useExtensionUI', async () => {
  const { ref } = await import('vue')
  const askUserReq = ref<ExtensionUIRequest | undefined>(undefined)
  return {
    __mockAskUserReq: askUserReq,
    useExtensionUI: () => ({
      currentAskUserRequest: askUserReq,
      respond: vi.fn(),
      cancel: vi.fn(),
    }),
    askUserFilter: (req: { askUser?: boolean }) => req.askUser === true,
  }
})

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    isActive: mockState.flowIsActive,
    state: { value: mockState.flowIsActive.value ? 'landing' : 'idle' },
    startFlow: vi.fn(),
    cancelFlow: vi.fn(),
    resetNewTaskFlow: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

// stub 子组件（断言其挂载位/互斥位；重渲染成本与重依赖隔离）
const stubs = {
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer-box" />' },
  AskUserOverlay: { template: '<div data-testid="ask-user-overlay" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
  TraceView: { template: '<div data-testid="trace-view" />' },
  WidgetArea: { template: '<div data-testid="widget-area" />' },
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionDir: '/repo',
    },
    global: { stubs },
  })
}

const askUserReq: ExtensionUIRequest = {
  sessionId: 's1',
  requestId: 'req-1',
  method: 'select',
  askUser: true,
  askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

// 拿 mock 工厂内建的同一 ref（直接改 .value 驱动挂载后重算）
const extUIMock = await import('@/composables/useExtensionUI')

function makeSession(id: string): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/repo',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'test-model',
    tokenCount: 0,
  }
}

/** 绑定有消息的会话 s1（真实 chat store hydrate） */
function hydrateS1Messages(): void {
  const chat = useChatStore()
  chat.hydrate('s1', [
    { id: 'm1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
  ])
}

beforeEach(() => {
  setActivePinia(createPinia())
  extUIMock.__mockAskUserReq.value = undefined
  mockState.flowIsActive.value = false
})

describe('PV1: flow 残留免疫（G2 结构实证——用户报告 bug 的原始触发态）', () => {
  it('flow 活跃 + 有会话有消息 → 对话流 + Composer 常驻，Landing 不渲染', () => {
    mockState.flowIsActive.value = true // flow 单例残留活跃（历史卡 landing / 未知缝隙）
    hydrateS1Messages()

    const wrapper = mountPanel('s1')

    // 用户可见：对话流与输入面同时在，输入面不因 flow 残留消失
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // Landing 判据读不到非空 sessionId——「有会话 × landing」在派生上不可表达
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })

  it('flow 活跃 + 有会话无消息（turn 活跃边界组合）→ 空对话态 + Composer', () => {
    mockState.flowIsActive.value = true

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('输入消息开始对话')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })
})

describe('PV2: landing（新建任务流程唯一承接场景：无 session + flow 活跃）', () => {
  it('无 session + flow 活跃 → Landing 渲染，band 不重复挂 Composer', () => {
    mockState.flowIsActive.value = true

    const wrapper = mountPanel(null)

    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
    // landing 态 composer 由 Landing 内嵌，band 不重复渲染（D5 判据）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
  })
})

describe('PV3: empty 兜底（flow 未活跃）', () => {
  it('绑定空会话（有 sid 无消息，flow idle）→ 空对话态 + Composer 供直输', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('输入消息开始对话')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })

  it('无 session + flow idle（选会话空态）→ 兜底空态文案，无输入面', () => {
    const wrapper = mountPanel(null)

    expect(wrapper.text()).toContain('选择左侧会话开始')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })
})

describe('PV4: dead 占位（W6：dead 不应答，派生优先级 dead > ask-user 承接）', () => {
  it('dead → 占位视图 + 重开入口，无 Composer', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(false)
  })

  it('dead + ask-user 请求在场 → 仍无 overlay（互斥由派生吞掉，收集侧不重复判）', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')
    extUIMock.__mockAskUserReq.value = askUserReq

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

describe('PV5: ask-user 互斥替换（D5：overlay ⟺ conversation && input===ask-user）', () => {
  it('有 ask-user 请求 → AskUserOverlay 替换 Composer', () => {
    hydrateS1Messages()
    extUIMock.__mockAskUserReq.value = askUserReq

    const wrapper = mountPanel('s1')

    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('应答出队后 → Composer 恢复（阻塞解除回到常驻输入面）', async () => {
    hydrateS1Messages()
    extUIMock.__mockAskUserReq.value = askUserReq
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)

    // 用户应答 → 请求出队（store 队列空）
    extUIMock.__mockAskUserReq.value = undefined
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})
