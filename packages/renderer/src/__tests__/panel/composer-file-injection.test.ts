/**
 * Composer file 注入集成测试（W2, U6-U9/R1/R3）。
 *
 * 验证 useComposerInjection 的 watch 消费行为：
 *  - U6 target=current 按 sessionId 匹配消费（insertFileChip 调用 + pendingInjection 清空）
 *  - U7 target=current sessionId 不匹配不消费（不误清，留给目标 composer）
 *  - U8 target=new 仅 landing composer（variant=landing）消费
 *  - U9 target=new 不被 session composer（variant=panel）消费
 *  - R1 端到端：store 写入 → Composer 真实消费 → DOM 真实 chip（real 层）
 *  - R3 target=new 真实路由 landing composer 消费（real 层，不依赖 sessionId 匹配）
 *
 * 策略同 composer-slash-injection.test.ts：真 pinia + 真 composerInjectionStore，
 * mock 其余 store/composable/api，ComposerInput stub 暴露 insertFileChip spy。
 * R1/R3 用真实 ComposerInput（验证真实 DOM chip）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock composable / api（防真依赖构造报错）──
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
  useNewTaskFlow: () => ({
    startFlow: vi.fn(),
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    state: { value: 'idle' },
    currentSessionId: { value: null },
    currentCwd: ref(null), // W4：useProjectSkills(flow.currentCwd) watch 需要真 ref，非裸对象
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  config: {
    // W4：useGlobalSkills/useProjectSkills 调用
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
  },
}))

// ── mock store（commandStore / chat / session / settings）──
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isStreaming: ref(false),
    isActive: () => false,
    getRetryState: () => undefined,
    getQueueState: () => undefined,
    isCompacting: () => false,
  }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], updateSessionState: vi.fn() }),
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ defaultModel: '' }),
}))
// commandStore mock：pendingSlash 不触发（本测试关注 file 注入，非 slash）
vi.mock('@/stores/command', () => ({
  useCommandStore: () => ({
    pendingSlash: ref(null),
    clearPendingSlash: vi.fn(),
  }),
}))

// ── ComposerInput mock：defineExpose 暴露 insertFileChip spy（U6-U9 mock 层）──
let composerInputSpies: Array<{ insertFileChip: ReturnType<typeof vi.fn> }> = []
vi.mock('@/components/panel/ComposerInput.vue', () => ({
  default: defineComponent({
    name: 'ComposerInput',
    emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
    setup() {
      const insertFileChip = vi.fn()
      const spy = { insertFileChip }
      composerInputSpies.push(spy)
      return { insertFileChip, focus: vi.fn() }
    },
    template: '<div data-testid="composer-input" />',
  }),
}))

import Composer from '@/components/panel/Composer.vue'
import { useComposerInjectionStore } from '@/stores/composer-injection'

beforeEach(() => {
  setActivePinia(createPinia())
  composerInputSpies = []
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

/** mount Composer（mock ComposerInput），返回 wrapper + insertFileChip spy */
function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  const wrapper = mount(Composer, { props, global: { stubs: otherStubs } })
  const spy = composerInputSpies.at(-1)?.insertFileChip
  if (!spy) throw new Error('ComposerInput spy 未生成')
  return { wrapper, spy }
}

describe('Composer file 注入 watch（W2）', () => {
  it('U6 target=current 按 sessionId 匹配消费 + 清空 pendingInjection', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'current', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('foo.ts', undefined)
    expect(store.pendingInjection).toBeNull()
  })

  it('U6b target=current 带 lineRange 透传给 insertFileChip', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = useComposerInjectionStore()
    store.requestInjection({
      target: 'current',
      path: 'foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledWith('foo.ts', [10, 20])
  })

  it('U7 target=current sessionId 不匹配不消费不误清', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'current', path: 'foo.ts', sessionId: 's2' })
    await flushPromises()

    expect(insertSpy).not.toHaveBeenCalled()
    // pendingInjection 仍在（留给 s2 composer）
    expect(store.pendingInjection).not.toBeNull()
  })

  it('U8 target=new 仅 landing composer（variant=landing）消费', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: null, variant: 'landing' })
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'new', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('foo.ts', undefined)
  })

  it('U9 target=new 不被 session composer（variant=panel）消费', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1', variant: 'panel' })
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'new', path: 'foo.ts', sessionId: 's1' })
    await flushPromises()

    // session composer 触发 startFlow + routeToLanding，但自身不注入
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
