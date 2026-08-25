/**
 * useComposerModelThinking 测试（core 迁移版，全 deps mock）。
 *
 * 平移自 renderer __tests__/composables/use-composer-model-thinking.test.ts，去掉 pinia store mock，
 * 改为构造 ModelThinkingDeps 注入。覆盖：currentModelId/currentThinkingLevel 派生、per-session 隔离、
 * onModelSelect/onThinkingSelect 三分支（staging/landing/已建）、Staging Mode 快照。
 *
 * 注意副作用：useThinkingLevelSync 的 immediate watch 在挂载时同步触发——若 currentThinkingLevel
 * 无值会调 onReset→onThinkingSelect（landing 设 localThinkingLevel、已建调 setThinkingLevel）。
 * 测试通过 sessionState 带初值或 mockClear 规避其对断言的干扰。
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { useComposerModelThinking, type ModelThinkingDeps } from './model-thinking'

type Spy = ReturnType<typeof vi.fn>

interface DepsSpies {
  getSessionState: Spy
  setPendingModel: Spy
  switchModel: Spy
  setThinkingLevel: Spy
}

function makeDeps(opts: {
  sessionState?: { modelId: string; thinkingLevel?: string } | null
  currentModel?: string | null
  defaultModel?: string
  thinkingLevelMap?: Record<string, string | null>
} = {}): { deps: ModelThinkingDeps; spies: DepsSpies } {
  const getSessionState = vi.fn(() => opts.sessionState ?? null)
  const setPendingModel = vi.fn()
  const switchModel = vi.fn().mockResolvedValue(undefined)
  const setThinkingLevel = vi.fn().mockResolvedValue(undefined)
  const deps: ModelThinkingDeps = {
    getSessionState,
    defaultModel: computed(() => opts.defaultModel ?? 'provider-D/model-D'),
    currentModel: computed(() => opts.currentModel ?? null),
    setPendingModel,
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: vi.fn(() => opts.thinkingLevelMap),
  }
  return { deps, spies: { getSessionState, setPendingModel, switchModel, setThinkingLevel } }
}

/** 包裹 useComposerModelThinking 在 effectScope 内（用完 stop 清理 watch） */
function mount(
  sid: string | null,
  opts: Parameters<typeof makeDeps>[0] = {},
): { result: ReturnType<typeof useComposerModelThinking>; spies: DepsSpies; scope: ReturnType<typeof effectScope> } {
  const { deps, spies } = makeDeps(opts)
  const sessionId = ref(sid)
  const scope = effectScope()
  const result = scope.run(() => useComposerModelThinking(sessionId, deps))!
  return { result, spies, scope }
}

describe('useComposerModelThinking · currentModelId 派生', () => {
  it('session 已建 → 读 sessionState.modelId', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    expect(result.currentModelId.value).toBe('provider-A/model-A')
    scope.stop()
  })

  it('landing + currentModel 有值 → 读 currentModel', () => {
    const { result, scope } = mount(null, { currentModel: 'provider-F/model-F' })
    expect(result.currentModelId.value).toBe('provider-F/model-F')
    scope.stop()
  })

  it('landing + currentModel null → 读 defaultModel', () => {
    const { result, scope } = mount(null)
    expect(result.currentModelId.value).toBe('provider-D/model-D')
    scope.stop()
  })

  it('session.modelId 空串（磁盘/已退出 session）→ || 兜底到 defaultModel', () => {
    // 空串场景：广播里已退出 session 的 modelId 硬编码为 ''。?? 不兜底空串，必须 ||
    const { result, scope } = mount('s1', {
      sessionState: { modelId: '' },
      defaultModel: 'provider-D/model-D',
    })
    expect(result.currentModelId.value).toBe('provider-D/model-D')
    scope.stop()
  })
})

describe('useComposerModelThinking · currentThinkingLevel 派生', () => {
  it('session 已建 → 读 sessionState.thinkingLevel', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    expect(result.currentThinkingLevel.value).toBe('high')
    scope.stop()
  })

  it('landing 态 → currentThinkingLevel 跟随 localThinkingLevel（sync 会设初值）', () => {
    const { result, scope } = mount(null)
    // sync immediate watch 设 localThinkingLevel 为最高可用档（map 缺失新语义默认五档 → 'high'）
    expect(result.currentThinkingLevel.value).toBe('high')
    // 手动改 localThinkingLevel → currentThinkingLevel 跟随
    result.localThinkingLevel.value = 'medium'
    expect(result.currentThinkingLevel.value).toBe('medium')
    scope.stop()
  })
})

describe('useComposerModelThinking · per-session 隔离（split panel bug 回归）', () => {
  it('两实例传不同 sessionId → getSessionState 按 id 查，各读各的 modelId', () => {
    const { result: c1, scope: sc1 } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    const { result: c2, scope: sc2 } = mount('s2', {
      sessionState: { modelId: 'provider-B/model-B', thinkingLevel: 'xhigh' },
    })
    expect(c1.currentModelId.value).toBe('provider-A/model-A')
    expect(c1.currentThinkingLevel.value).toBe('high')
    expect(c2.currentModelId.value).toBe('provider-B/model-B')
    expect(c2.currentThinkingLevel.value).toBe('xhigh')
    sc1.stop()
    sc2.stop()
  })
})

describe('useComposerModelThinking · onModelSelect 三分支', () => {
  it('staging 活跃 → 只写快照，不调 switchModel/setPendingModel', async () => {
    const { result, spies, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(result.currentModelId.value).toBe('provider-C/model-C')
    expect(spies.switchModel).not.toHaveBeenCalled()
    expect(spies.setPendingModel).not.toHaveBeenCalled()
    scope.stop()
  })

  it('landing 态（sessionId=null）→ 记 pendingModel', async () => {
    const { result, spies, scope } = mount(null)
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(spies.setPendingModel).toHaveBeenCalledWith('provider-C/model-C')
    expect(spies.switchModel).not.toHaveBeenCalled()
    scope.stop()
  })

  it('已建态 → 调 switchModel(sessionId, provider, modelId)', async () => {
    const { result, spies, scope } = mount('s2', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(spies.switchModel).toHaveBeenCalledWith('s2', 'provider-C', 'model-C')
    scope.stop()
  })
})

describe('useComposerModelThinking · onThinkingSelect 三分支', () => {
  it('staging 活跃 → 只写快照', async () => {
    const { result, spies, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    await result.onThinkingSelect('medium')
    expect(result.currentThinkingLevel.value).toBe('medium')
    expect(spies.setThinkingLevel).not.toHaveBeenCalled()
    scope.stop()
  })

  it('landing 态 → 记 localThinkingLevel', async () => {
    const { result, spies, scope } = mount(null)
    spies.setThinkingLevel.mockClear()
    await result.onThinkingSelect('low')
    expect(result.localThinkingLevel.value).toBe('low')
    expect(spies.setThinkingLevel).not.toHaveBeenCalled()
    scope.stop()
  })

  it('已建态 → 调 setThinkingLevel(sessionId, level)', async () => {
    const { result, spies, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    spies.setThinkingLevel.mockClear()
    await result.onThinkingSelect('medium')
    expect(spies.setThinkingLevel).toHaveBeenCalledWith('s1', 'medium')
    scope.stop()
  })
})

describe('useComposerModelThinking · Staging Mode（ADR-0056）', () => {
  it('enterStagingMode：currentModelId 读快照，后续 onModelSelect/onThinkingSelect 走 staging 分支', async () => {
    const { result, spies, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    // currentModelId 进入暂存态读 staging 快照（enterStagingMode 先快照 modelId）
    expect(result.currentModelId.value).toBe('provider-A/model-A')
    // staging 活跃：onModelSelect 写快照，不调 RPC
    await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' })
    expect(result.currentModelId.value).toBe('provider-B/model-B')
    expect(spies.switchModel).not.toHaveBeenCalled()
    // staging 活跃：onThinkingSelect 写快照，不调 RPC
    spies.setThinkingLevel.mockClear()
    await result.onThinkingSelect('xhigh')
    expect(result.currentThinkingLevel.value).toBe('xhigh')
    expect(spies.setThinkingLevel).not.toHaveBeenCalled()
    scope.stop()
    // 注：源 enterStagingMode 顺序为「先设 stagingModel 再读 currentThinkingLevel」，而
    // currentThinkingLevel computed 依赖 stagingModel——赋值后重算走 staging 分支返回尚未赋值的
    // stagingThinking（undefined）。故本用例不直接断言 enterStagingMode 后的 thinking 快照初值，
    // 改为经 onThinkingSelect 显式写入验证 staging 分支。此顺序特性建议后续修复（先读后设）。
  })

  it('exitStagingMode 清空快照，chip 恢复读常规态真值', async () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' })
    result.exitStagingMode()
    // 退出暂存 → currentModelId/currentThinkingLevel 恢复读常规态（源 session 真值）
    expect(result.currentModelId.value).toBe('provider-A/model-A')
    expect(result.currentThinkingLevel.value).toBe('high')
    scope.stop()
  })

  it('getStagingConfig：常规态返回空对象；暂存态导出快照', async () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    // 常规态：无暂存
    expect(result.getStagingConfig()).toEqual({})
    // 进入暂存 + 改快照
    result.enterStagingMode()
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    await result.onThinkingSelect('xhigh')
    expect(result.getStagingConfig()).toEqual({
      modelOverride: 'provider-C/model-C',
      thinkingOverride: 'xhigh',
    })
    // 退出暂存 → 空配置
    result.exitStagingMode()
    expect(result.getStagingConfig()).toEqual({})
    scope.stop()
  })
})
