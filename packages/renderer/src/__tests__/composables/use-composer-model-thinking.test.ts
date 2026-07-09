/**
 * useComposerModelThinking per-session 隔离测试。
 *
 * 核心场景（split panel bug 回归）：两个 Composer 实例传不同 sessionId，
 * 各自读各自 session 的 modelId/thinkingLevel，不串读全局 active。
 *
 * 背景：原实现读 sessionStore.active（全局焦点 session），split 下非聚焦 panel
 * 会显示另一个 panel 的值。修复后改为按 sessionId 从 sessionStore.list 查真值。
 *
 * 运行：npx vitest run src/__tests__/composables/use-composer-model-thinking.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock useNewTaskFlow（landing 态 currentModel）──
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    submitFirstMessage: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

// ── mock useModel（switchModel/setThinkingLevel spy，不真实调 RPC）──
const switchModelMock = vi.fn()
const setThinkingLevelMock = vi.fn()
vi.mock('@/composables/features/useModel', () => ({
  useModel: () => ({
    switchModel: switchModelMock,
    setThinkingLevel: setThinkingLevelMock,
  }),
}))

// ── mock @/api（useModel 内部调 model.switchModel / session.setThinkingLevel）──
vi.mock('@/api', () => ({
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
}))

import { useComposerModelThinking } from '@/composables/panel/useComposerModelThinking'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import type { SessionGroup } from '@xyz-agent/shared'

beforeEach(() => {
  setActivePinia(createPinia())
  switchModelMock.mockClear()
  setThinkingLevelMock.mockClear()
})

function makeSession(id: string, modelId: string, thinkingLevel?: string) {
  return {
    id,
    label: id,
    cwd: '/test',
    modelId,
    thinkingLevel,
    status: 'idle' as const,
  }
}

function setSessions(sessions: ReturnType<typeof makeSession>[]) {
  const sessionStore = useSessionStore()
  const group: SessionGroup = { cwd: '/test', sessions }
  sessionStore.setGroups([group])
}

describe('useComposerModelThinking · per-session 隔离（split panel bug 回归）', () => {
  it('两个实例传不同 sessionId → 各读各的 modelId，不串读', () => {
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const c1 = useComposerModelThinking(computed(() => 's1'))
    const c2 = useComposerModelThinking(computed(() => 's2'))

    // 各自读自身 sessionId 对应的 session 真值，不串读
    expect(c1.currentModelId.value).toBe('provider-A/model-A')
    expect(c2.currentModelId.value).toBe('provider-B/model-B')
  })

  it('两个实例传不同 sessionId → 各读各的 thinkingLevel，不串读', () => {
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const c1 = useComposerModelThinking(computed(() => 's1'))
    const c2 = useComposerModelThinking(computed(() => 's2'))

    expect(c1.currentThinkingLevel.value).toBe('high')
    expect(c2.currentThinkingLevel.value).toBe('xhigh')
  })

  it('切换 activeId 不影响各 Composer 的显示（关键回归点）', async () => {
    // 原 bug：activeId 变化后，读 active 的 Composer 会显示新 active 的值。
    // 修复后读 sessionState（按 sessionId 查），activeId 变化不影响。
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const sessionStore = useSessionStore()
    const c1 = useComposerModelThinking(computed(() => 's1'))
    const c2 = useComposerModelThinking(computed(() => 's2'))

    // 初始：各自读各的
    expect(c1.currentModelId.value).toBe('provider-A/model-A')
    expect(c2.currentModelId.value).toBe('provider-B/model-B')

    // 切 activeId 到 s2（模拟点 s2 panel 聚焦）
    sessionStore.activeId = 's2'
    await nextTick()

    // c1 仍读 s1 的值，不受 activeId 变化影响
    expect(c1.currentModelId.value).toBe('provider-A/model-A')
    expect(c1.currentThinkingLevel.value).toBe('high')
    // c2 读 s2 的值
    expect(c2.currentModelId.value).toBe('provider-B/model-B')
  })

  it('updateSessionState 按 id 更新 → 只有对应 Composer 显示变化', async () => {
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const sessionStore = useSessionStore()
    const c1 = useComposerModelThinking(computed(() => 's1'))
    const c2 = useComposerModelThinking(computed(() => 's2'))

    // 只更新 s1 的 modelId（模拟 s1 panel 切模型）
    sessionStore.updateSessionState('s1', { modelId: 'provider-C/model-C' })
    await nextTick()

    // c1 跟随更新，c2 不受影响
    expect(c1.currentModelId.value).toBe('provider-C/model-C')
    expect(c2.currentModelId.value).toBe('provider-B/model-B')
  })

  it('onModelSelect 已建态按自身 sessionId 调 switchModel（不串调到其他 session）', async () => {
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const c2 = useComposerModelThinking(computed(() => 's2'))
    await c2.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })

    // 应该用 s2 的 sessionId 调 switchModel，不是 active 的
    expect(switchModelMock).toHaveBeenCalledWith('s2', 'provider-C', 'model-C')
  })

  it('onThinkingSelect 已建态按自身 sessionId 调 setThinkingLevel', async () => {
    setSessions([
      makeSession('s1', 'provider-A/model-A', 'high'),
      makeSession('s2', 'provider-B/model-B', 'xhigh'),
    ])

    const c1 = useComposerModelThinking(computed(() => 's1'))
    await c1.onThinkingSelect('medium')

    expect(setThinkingLevelMock).toHaveBeenCalledWith('s1', 'medium')
  })
})

describe('useComposerModelThinking · landing 态（sessionId=null）回退', () => {
  it('sessionId=null → currentModelId 回退 flow.currentModel → settingsStore.defaultModel', () => {
    setSessions([makeSession('s1', 'provider-A/model-A', 'high')])

    const settings = useSettingsStore()
    settings.defaultModel = 'provider-D/model-D'

    const c = useComposerModelThinking(computed(() => null))
    // landing 态无 session → flow.currentModel(null) → defaultModel
    expect(c.currentModelId.value).toBe('provider-D/model-D')
  })

  it('sessionId=null → currentThinkingLevel 回退 localThinkingLevel', async () => {
    setSessions([makeSession('s1', 'provider-A/model-A', 'high')])

    const c = useComposerModelThinking(computed(() => null))
    // landing 态 useThinkingLevelSync 的 immediate watch 会设 localThinkingLevel 为
    // 当前模型最高可用档（landing 态默认思考强度），非 undefined
    // 这里验证 localThinkingLevel 驱动 currentThinkingLevel
    const initial = c.currentThinkingLevel.value
    expect(initial).toBeDefined()

    // 手动改 localThinkingLevel → currentThinkingLevel 跟随
    c.localThinkingLevel.value = 'medium'
    expect(c.currentThinkingLevel.value).toBe('medium')
  })
})

describe('useComposerModelThinking · modelId 空串兜底', () => {
  it('session.modelId 为空串（磁盘/已退出 session）→ 回退到 defaultModel', () => {
    // 空串场景：广播里已退出 session 的 modelId 硬编码为 ''
    setSessions([makeSession('s1', '', undefined)])

    const settings = useSettingsStore()
    settings.defaultModel = 'provider-D/model-D'

    const c = useComposerModelThinking(computed(() => 's1'))
    // || 兜底空串到 defaultModel（?? 不兜底空串会导致显示消失）
    expect(c.currentModelId.value).toBe('provider-D/model-D')
  })
})
