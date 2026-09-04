/**
 * useComposerModelThinking 测试（core 迁移版，全 deps mock）。
 *
 * 平移自 renderer __tests__/composables/use-composer-model-thinking.test.ts，去掉 pinia store mock，
 * 改为构造 ModelThinkingDeps 注入。覆盖：currentModelId/currentThinkingLevel 派生、per-session 隔离、
 * onModelSelect/onThinkingSelect 三分支（staging/landing/已建）、Staging Mode 快照。
 *
 * [u3] 追加记忆恢复套件（设计 model-thinking-level-memory.md D2/D3 探针表）：
 * - armed 序列族 9 断言点：armed 为内部状态，全部经行为序列断言（恢复 RPC 是否发出 =
 *   token 设立/保留/消费/清除的可观测投影），用真实 u1 memory API（record 预置记忆）
 * - 跟随三行为 / 双路径污染反例（gated KV 控制预载完成时刻）/ 记录门禁（真实 memory Map 断言）
 *
 * 注意副作用：useThinkingLevelSync 的 immediate watch 在挂载时同步触发——若 currentThinkingLevel
 * 无值会调 onReset→routeThinkingLevel（内部对齐路由，不置 localAuthored；landing 设
 * localThinkingLevel、已建调 setThinkingLevel）。测试通过 sessionState 带初值或 mockClear
 * 规避其对断言的干扰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import { useComposerModelThinking, type ModelThinkingDeps } from './model-thinking'
import {
  MODEL_THINKING_MEMORY_KEY,
  __resetModelThinkingMemoryForTesting,
  lookup,
  record,
} from './model-thinking-memory'
import {
  record as recordLastUsed,
  lookup as lookupLastUsed,
  __resetLastUsedModelForTesting,
} from './last-used-model'
import { resolveThinkingValue } from './thinking-levels'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../platform/port'

type Spy = ReturnType<typeof vi.fn>

interface DepsSpies {
  getSessionState: Spy
  setPendingModel: Spy
  switchModel: Spy
  setThinkingLevel: Spy
  getSupportedLevels: Spy
}

function makeDeps(opts: {
  sessionState?: { modelId: string; thinkingLevel?: string } | null
  currentModel?: string | null
  defaultModel?: string
  thinkingLevelMap?: Record<string, string | null>
  /** U6 切源：档位可用集（缺省 undefined → 归一默认五档，与旧断言兼容） */
  supportedLevels?: string[]
} = {}): { deps: ModelThinkingDeps; spies: DepsSpies } {
  const getSessionState = vi.fn(() => opts.sessionState ?? null)
  const setPendingModel = vi.fn()
  const switchModel = vi.fn().mockResolvedValue(undefined)
  const setThinkingLevel = vi.fn().mockResolvedValue(undefined)
  const getSupportedLevels = vi.fn(() => opts.supportedLevels)
  const deps: ModelThinkingDeps = {
    getSessionState,
    defaultModel: computed(() => opts.defaultModel ?? 'provider-D/model-D'),
    currentModel: computed(() => opts.currentModel ?? null),
    setPendingModel,
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: vi.fn(() => opts.thinkingLevelMap),
    getSupportedLevels,
  }
  return { deps, spies: { getSessionState, setPendingModel, switchModel, setThinkingLevel, getSupportedLevels } }
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

// ══════════ [u3] 记忆恢复套件公共基建 ══════════

/** 平面 KV stub：u1 memory 模块写穿落点（避免无 platform 时 E2 warn 噪音） */
class MemKV implements KVStorage {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/**
 * 可控时序 KV：closeGate 挂起 get、openGateNow 放行——控制 u1 预载完成时刻
 * （P2 晚到补写场景：跟随落在 KV 加载前 → 加载完成回调补一次重设，E7②）。
 * initialTable 预置在权威 key 下的整表数据。
 */
class GatedKV extends MemKV {
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null
  private raw: string | null
  constructor(initialTable?: Record<string, string>) {
    super()
    this.raw = initialTable ? JSON.stringify(initialTable) : null
    if (initialTable) void this.set(MODEL_THINKING_MEMORY_KEY, this.raw)
  }
  closeGate(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }
  openGateNow(): void {
    this.open?.()
    this.open = null
  }
  override async get(key: string): Promise<string | null> {
    if (this.gate) await this.gate
    return super.get(key)
  }
}

function provideMockPlatform(storage: KVStorage): void {
  const port: PlatformPort = {
    kind: 'mock',
    storage,
    // 本文件只走 storage 端口；webSocket 被触达即测试写错，抛错暴露
    webSocket: {
      create: () => {
        throw new Error('stub: WebSocketFactory 未在本测试使用')
      },
    },
    ipc: null,
  }
  providePlatform(port)
}

// u1 memory 是模块级单例（KV 经 platform 注入）——每用例重置模块态 + 干净 KV，
// 避免跨用例记忆泄漏；既有用例的 record 写穿也由此落到内存 KV（无 E2 warn 噪音）
beforeEach(() => {
  provideMockPlatform(new MemKV())
  __resetModelThinkingMemoryForTesting()
  __resetLastUsedModelForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetPlatformForTesting()
  __resetModelThinkingMemoryForTesting()
  __resetLastUsedModelForTesting()
})

/**
 * 同内容异身份 map 工厂：identity 变化触发 sync watch（观察源按 Object.is 比较），
 * 内容恒等使既有对齐分支天然静默（同体系 + value 不变 → 不发 RPC）——
 * 「是否有恢复 onReset」因此可被干净断言（恢复是唯一会调 setThinkingLevel 的路径）。
 */
const sameContentMap = () => ({ off: 'o', low: 'l', medium: 'm', high: 'h' })
const fourLevels = ['off', 'low', 'medium', 'high']

/** switchModel 手动可控调用：applyAndResolve 模拟壳层「applySnapshot 同步执行 + RPC resolve」时序 */
interface SwitchCall {
  provider: string
  modelId: string
  /**
   * 先同步 applySnapshot(生效模型)（watch flush 微任务在此入队）再 resolve（await 续段
   * 后入队）——对齐 D3 证据②时序：flush 总是先于 onModelSelect 的规则 5 续段。
   */
  applyAndResolve: (effectiveModelId: string) => void
  reject: (err: unknown) => void
}

/**
 * armed/记忆套件 harness：响应式 sessionState / defaultModel / currentModel / providers
 * （既有 makeDeps 的 vi.fn 闭包非响应式，无法模拟 applySnapshot / defaultModel 晚到 /
 * providers 刷新——这些恰是 armed 序列族的驱动源）。
 */
function mountMem(opts: {
  sid?: string | null
  session?: { modelId: string; thinkingLevel?: string } | null
  defaultModel?: string
  currentModel?: string | null
  maps?: Record<string, Record<string, string | null>>
  supported?: Record<string, string[]>
} = {}) {
  const sessionRef = ref<{ modelId: string; thinkingLevel?: string } | null>(opts.session ?? null)
  const defaultModelRef = ref(opts.defaultModel ?? '')
  const currentModelRef = ref<string | null>(opts.currentModel ?? null)
  const providersRef = ref<Record<string, Record<string, string | null>>>(opts.maps ?? {})
  const supportedRef = ref<Record<string, string[]>>(opts.supported ?? {})
  const pending: SwitchCall[] = []
  const switchModel = vi.fn(
    (_sid: string, provider: string, modelId: string) =>
      new Promise<void>((resolve, reject) => {
        pending.push({
          provider,
          modelId,
          applyAndResolve: (effective: string) => {
            sessionRef.value = {
              modelId: effective,
              thinkingLevel: sessionRef.value?.thinkingLevel,
            }
            resolve()
          },
          reject,
        })
      }),
  )
  const setThinkingLevel = vi.fn().mockResolvedValue(undefined)
  // [R2-fix-2] 生产保真：flow.setPendingModel 是同步 ref 写（flow.ts:366-369），经
  // pendingModel → currentModel → currentModelId 同步 computed 传播——no-op mock 会
  // 掩盖「写后读」时序类回归（R2-fix-1 教训）。vi.fn 包真实写，保留调用断言能力。
  const setPendingModel = vi.fn((m: string) => {
    currentModelRef.value = m
  })
  const deps: ModelThinkingDeps = {
    getSessionState: () => (sessionRef.value ? { ...sessionRef.value } : null),
    defaultModel: computed(() => defaultModelRef.value),
    currentModel: computed(() => currentModelRef.value),
    setPendingModel,
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: (id: string) => providersRef.value[id],
    getSupportedLevels: (id: string) => supportedRef.value[id],
  }
  const sessionId = ref<string | null>(opts.sid ?? null)
  const scope = effectScope()
  const result = scope.run(() => useComposerModelThinking(sessionId, deps))!
  return {
    result,
    sessionId,
    sessionRef,
    defaultModelRef,
    currentModelRef,
    providersRef,
    switchModel,
    setThinkingLevel,
    setPendingModel,
    pending,
    scope,
  }
}

/** 刷新某模型 map 的 identity（内容不变）——模拟 providers 数组刷新触发的无关 watch 回调 */
function refreshProviderIdentity(
  providersRef: Ref<Record<string, Record<string, string | null>>>,
  modelId: string,
): void {
  providersRef.value = { ...providersRef.value, [modelId]: { ...providersRef.value[modelId] } }
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

  it('session.modelId 空串（磁盘/已退出 session）→ D3 占位不回落 defaultModel', () => {
    // 空串场景：广播里已退出 session 的 modelId 硬编码为 ''。D3 已建态空值→占位，不兜底
    const { result, scope } = mount('s1', {
      sessionState: { modelId: '' },
      defaultModel: 'provider-D/model-D',
    })
    expect(result.currentModelId.value).toBe('')
    scope.stop()
  })
})

describe('useComposerModelThinking · currentSupportedLevels 派生（U6 切源）', () => {
  it('读 deps.getSupportedLevels(currentModelId)，未下发时 undefined（归一默认五档）', () => {
    const { result, scope, spies } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      supportedLevels: ['off', 'high'],
    })
    expect(result.currentSupportedLevels.value).toEqual(['off', 'high'])
    expect(spies.getSupportedLevels).toHaveBeenCalledWith('provider-A/model-A')
    scope.stop()
  })

  it('未注入值（undefined）→ currentSupportedLevels 为 undefined，下游归一默认五档', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    expect(result.currentSupportedLevels.value).toBeUndefined()
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
  it('enterStagingMode：currentModelId/currentThinkingLevel 读快照，后续 onModelSelect/onThinkingSelect 走 staging 分支', async () => {
    const { result, spies, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    // 快照初值直断言：源 enterStagingMode 为「先快照 stagingThinking 再置 stagingModel」——
    // stagingModel 置位后两个 computed 才切读 staging 分支，故读到的都是切换前的常规态原值，
    // 快照初值可直接断言（若回退为反序，thinking 快照会落 undefined，见下一用例守卫）
    expect(result.currentModelId.value).toBe('provider-A/model-A')
    expect(result.currentThinkingLevel.value).toBe('high')
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
  })

  it('enterStagingMode 快照直断言：快照初值即原值（先快照后切换，防反序回退）', () => {
    // 反序回退守卫：旧顺序「先置 stagingModel 再读 currentThinkingLevel」下，stagingModel
    // 置位后 currentThinkingLevel computed 即切读 staging 分支，读到尚未赋值的
    // stagingThinking（undefined）写进快照——此断言在旧顺序下必红
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'p/m1', thinkingLevel: 'h' },
    })
    result.enterStagingMode()
    expect(result.currentThinkingLevel.value).toBe('h')
    expect(result.currentModelId.value).toBe('p/m1')
    scope.stop()
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

// ══════════ [u3] armed 序列族（设计 §3.3 探针表第 1 行，D3 六防线设立侧）══════════
//
// 断言策略：armed 是内部状态，全部经行为序列断言——记忆恢复是「同内容异身份 map」下
// 唯一会调 setThinkingLevel 的路径（既有对齐分支静默），故「恢复 RPC 是否发出」即
// token 设立/保留/消费/清除的可观测投影。预置记忆用真实 u1 record()。
// 已建态基线：s1 =（p/X，'h'），X/Y/Z 同体系（sameContentMap 异身份 + fourLevels）。
function mountArmedBaseline() {
  return mountMem({
    sid: 's1',
    session: { modelId: 'p/X', thinkingLevel: 'h' },
    maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap(), 'p/Z': sameContentMap() },
    supported: { 'p/X': fourLevels, 'p/Y': fourLevels, 'p/Z': fourLevels },
  })
}

describe('useComposerModelThinking · armed 序列族（D3 六防线）', () => {
  it('S1/(a) RPC 失败 → 规则 4 清自己 token；换绑到同模型 session 不误恢复', async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low') // 恢复值 'l'——若失败 token 残留，换绑后会以 'l' 伪恢复
    const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' })
    h.pending[0].reject(new Error('rpc fail'))
    await expect(p).rejects.toThrow('rpc fail')
    // 换绑到 s2（模型恰为 armed 目标 Y，档位 'm'）——armed 已被规则 4 清除，不得恢复
    h.sessionId.value = 's2'
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
    await nextTick()
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    h.scope.stop()
  })

  it('S2/(b) 并发连切重叠窗口：第一调用成功清不误清后来者 token，恢复只发生在第二调用目标', async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low') // Y 的恢复值 'l'
    record('p/Z', 'medium') // Z 的恢复值 'm'——两值区分「哪个 token 消费了」
    const p1 = h.result.onModelSelect({ modelId: 'Y', provider: 'p' })
    const p2 = h.result.onModelSelect({ modelId: 'Z', provider: 'p' }) // armed 覆盖为 Z（所有权转移）
    // 第一调用回包（生效 Y）：armed={Z} 不匹配 → 规则 3 保留；规则 5 只清 id1 → 不误清 Z
    h.pending[0].applyAndResolve('p/Y')
    await p1
    expect(h.setThinkingLevel).not.toHaveBeenCalled() // Y 的恢复未发生（token 已是 Z 的）
    // 第二调用回包（生效 Z）：Z token 存活至自己的回包 → 匹配消费恢复
    h.pending[1].applyAndResolve('p/Z')
    await p2
    expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'm') // Z 的记忆值，非 Y 的 'l'
    h.scope.stop()
  })

  it("S3/(b') providers 刷新触发无关回调 → 规则 3 保留 token，恢复不丢失", async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low')
    const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' }) // RPC 在途，armed={Y}
    // runtime 推 config.providers 广播：数组引用变化触发 watch，但模型尚未到达目标
    refreshProviderIdentity(h.providersRef, 'p/X')
    await nextTick()
    expect(h.setThinkingLevel).not.toHaveBeenCalled() // 不匹配 → 不消费也不清
    // RPC 回包生效 Y → 匹配消费恢复（token 在无关触发中存活）
    h.pending[0].applyAndResolve('p/Y')
    await p
    expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
    h.scope.stop()
  })

  it('S4/跨模型换绑基线（G3）：无 armed 时换绑跨模型 session → 不恢复，各 session 档位保持', async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low')
    // 无任何显式切模型（armed 恒 null）→ 从 s1（X）换绑到 s2（Y，档位 'm'）
    h.sessionId.value = 's2'
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
    await nextTick()
    // 记忆 Y='low' 存在且可用，但无 armed 门禁放行 → 不得改写 s2 档位
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    expect(h.sessionRef.value?.thinkingLevel).toBe('m')
    h.scope.stop()
  })

  it('S5/E9 静默换模：请求 Y 生效 Z → 既有对齐处理 Z，规则 5 清残留 token，无延迟伪恢复', async () => {
    // Z 用两档体系（与 X 跨体系）：既有对齐会重置到最高可用档——「对齐处理了 Z」可观测
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap(), 'p/Z': { off: 'zo', low: 'zl' } },
      supported: { 'p/X': fourLevels, 'p/Y': fourLevels, 'p/Z': ['off', 'low'] },
    })
    record('p/Y', 'low')
    const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' })
    h.pending[0].applyAndResolve('p/Z') // pi 静默换模：请求 Y 生效 Z
    await p
    // armed={Y} vs current p/Z 不匹配（规则 3 保留）→ 既有跨体系对齐重置 Z 档位
    // highestAvailableLevel(['off','low']) = 'low' → resolve('low', Z map) = 'zl'
    expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'zl')
    // 规则 5 已清残留 token：后续无关触发（providers 刷新）不再延迟伪恢复——
    // 判据 = armed 目标 Y 的记忆值 'l' 永不发出（mock setThinkingLevel 不回写 store，
    // 无关触发会重发对齐值 'zl'，属既有行为与 armed 无关，故不断言总次数）
    refreshProviderIdentity(h.providersRef, 'p/Z')
    await nextTick()
    expect(h.setThinkingLevel).not.toHaveBeenCalledWith('s1', 'l')
    h.scope.stop()
  })

  it('S6/E10 慢 RPC（>5s）回包：in-flight 豁免窗内正常匹配消费，规则 1 不误杀', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // 只伪造 Date.now（armed.at 与规则 1 的时钟），微任务时序保持真实
    try {
      const h = mountArmedBaseline()
      record('p/Y', 'low')
      const t0 = Date.now()
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' }) // armed.at = t0
      vi.setSystemTime(t0 + 6000) // 回包时刻已超 5s 保险丝
      h.pending[0].applyAndResolve('p/Y')
      await p
      // flush 发生在 finally 撤销 in-flight 之前（D3 证据②）：计数仍为 1 → 过期不生效 → 正常消费
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
      h.scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('S7/re-select 同模型：watch 不触发 → token 未消费，规则 5 成功清，无残留伪恢复', async () => {
    const h = mountArmedBaseline()
    record('p/X', 'low') // 同模型也有记忆——若 token 残留，后续触发会以 'l' 伪恢复
    const p = h.result.onModelSelect({ modelId: 'X', provider: 'p' }) // re-select 同模型
    h.pending[0].applyAndResolve('p/X') // modelId 不变 → 观察源不变 → watch 不触发
    await p
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    // 规则 5 清除后，无关触发不得消费陈旧 token
    refreshProviderIdentity(h.providersRef, 'p/X')
    await nextTick()
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    h.scope.stop()
  })

  it('S8/规则 6 换绑清：RPC 在途时换绑 → armed 先清后消费检查，目标模型 session 不被改写', async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low')
    void h.result.onModelSelect({ modelId: 'Y', provider: 'p' }) // RPC 永不回包（在途）
    // 换绑到 s2（模型恰为 armed 目标 Y，档位 'm'）——换绑即作废全部未消费意图
    h.sessionId.value = 's2'
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
    await nextTick()
    // 若换绑清晚于消费检查（注册序错误），此处会以记忆 'l' 伪恢复 s2 的档位
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    h.scope.stop()
  })

  it('S9/基础序列：设立 → 匹配消费 → 恢复记忆档位经 onReset 通路（G1 happy path）', async () => {
    const h = mountArmedBaseline()
    record('p/Y', 'low')
    const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' })
    h.pending[0].applyAndResolve('p/Y')
    await p
    // 规则 2：match + 命中 + 'l' ≠ 'h' → setThinkingLevel(s1, 'l')；既有分支被 return 跳过
    expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
    // 消费即清（一次性 token）：后续无关触发不再重复恢复
    refreshProviderIdentity(h.providersRef, 'p/Y')
    await nextTick()
    expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
    h.scope.stop()
  })
})

// ══════════ [u3] landing 跟随三行为 + 双路径污染反例（设计探针表第 2 行，D2）══════════
function mountLanding(opts: { defaultModel?: string } = {}) {
  return mountMem({
    sid: null,
    defaultModel: opts.defaultModel ?? '',
    maps: { 'p/M': sameContentMap(), 'p/N': sameContentMap() },
    supported: { 'p/M': fourLevels, 'p/N': fourLevels },
  })
}

describe('useComposerModelThinking · landing 跟随（D2 memory-aware）', () => {
  it('F1/早到 + memory 命中：immediate 跟随重设为记忆档位（sync auto 值被覆盖）；后续模型变化仍跟随（auto 不置 authored）', async () => {
    record('p/M', 'low')
    record('p/N', 'medium')
    const h = mountLanding({ defaultModel: 'p/M' })
    // sync immediate 先设最高档 'h'，follow immediate 随后覆盖为记忆值 'l'——
    // 若 onReset 误走用户入口（置位 authored），此处会停留在 'h'（D2 拆分入口锁定）
    expect(h.result.currentThinkingLevel.value).toBe('l')
    // 模型变化再跟随一次：证明 auto 初始化没有冻结跟随（authored 仍为 false）
    h.defaultModelRef.value = 'p/N'
    await nextTick()
    expect(h.result.currentThinkingLevel.value).toBe('m')
    h.scope.stop()
  })

  it('F2/晚到 + memory 命中：defaultModel 从空串到达 → 变化触发跟随重设', async () => {
    record('p/M', 'low')
    const h = mountLanding({ defaultModel: '' }) // 挂载时模型 ''（defaultModel 晚到路径）
    expect(h.result.currentThinkingLevel.value).toBe('high') // 无模型 → 最高可用档（value=key）
    h.defaultModelRef.value = 'p/M'
    await nextTick()
    expect(h.result.currentThinkingLevel.value).toBe('l')
    h.scope.stop()
  })

  it('F3/authored 后冻结：用户显式选档后，模型变化不再跟随，用户值保持', async () => {
    record('p/M', 'low')
    record('p/N', 'medium')
    const h = mountLanding({ defaultModel: 'p/M' })
    expect(h.result.currentThinkingLevel.value).toBe('l')
    await h.result.onThinkingSelect('h') // 用户显式入口 → authored 置位
    h.defaultModelRef.value = 'p/N'
    await nextTick()
    expect(h.result.currentThinkingLevel.value).toBe('h') // 不被 memory[N] 'm' 改写
    h.scope.stop()
  })
})

describe('useComposerModelThinking · 双路径污染反例（D2 被否③ 击穿序列）', () => {
  it('P1/早到路径：landing auto 值 = 记忆值，经首发透传建 session 后 memory 不被最高档覆写', async () => {
    record('p/M', 'low')
    const h = mountLanding({ defaultModel: 'p/M' })
    // 首发透传的值 = local（若跟随失效会是 auto 'h'，污染经记录 watch 覆写 memory）
    expect(h.result.currentThinkingLevel.value).toBe('l')
    // 模拟 submitFirstMessage：session create + flow apply local 值
    h.sessionId.value = 's1'
    h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'l' }
    await nextTick()
    expect(lookup('p/M')).toBe('low') // 终态：未被 auto 最高档 'high' 覆写
    h.scope.stop()
  })

  it('P2/晚到路径（E7②）：预载完成前跟随落最高档，加载完成回调补写为记忆值，首发后 memory 不被覆写', async () => {
    // 记忆只存在于 KV（未加载）：模拟 app 冷启动，预载慢于 composer 组装
    const gated = new GatedKV({ 'p/M': 'low' })
    gated.closeGate()
    provideMockPlatform(gated)
    __resetModelThinkingMemoryForTesting()
    const h = mountLanding({ defaultModel: 'p/M' })
    // E7① 窗口：KV 在途 → lookup 未命中 → 跟随落最高档（与现状一致）
    expect(h.result.currentThinkingLevel.value).toBe('h')
    // KV 预载完成（宏任务边界落地加载链）→ onLoaded 补一次跟随重设（E7② 消灭窗口）
    gated.openGateNow()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(h.result.currentThinkingLevel.value).toBe('l')
    // 首发建 session（透传补写后的记忆值）→ memory 保持 'low'
    h.sessionId.value = 's1'
    h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'l' }
    await nextTick()
    expect(lookup('p/M')).toBe('low')
    h.scope.stop()
  })
})

// ══════════ [u3] 记录 watch 双条件门禁（D2）══════════
describe('useComposerModelThinking · 记录 watch 门禁（D2 双条件）', () => {
  it('R1/landing 悬空值不入表：模型/档位变化均不写记忆', async () => {
    const h = mountLanding({ defaultModel: 'p/M' })
    expect(h.result.currentThinkingLevel.value).toBe('h') // sync auto 最高档经 map 映射（无记忆）
    h.defaultModelRef.value = 'p/N'
    await nextTick()
    expect(lookup('p/M')).toBeUndefined()
    expect(lookup('p/N')).toBeUndefined()
    h.scope.stop()
  })

  it('R2/staging 试选值不入表：快照模型/档位不写记忆，源 session 记忆不被扰动', async () => {
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': { off: 'o', high: 'h' }, 'p/Y': { off: 'o', high: 'h' } },
      supported: { 'p/X': ['off', 'high'], 'p/Y': ['off', 'high'] },
    })
    // mount 即记录载入的既有状态（条件 b：session 加载既有状态）
    expect(lookup('p/X')).toBe('high')
    h.result.enterStagingMode()
    await h.result.onModelSelect({ modelId: 'Y', provider: 'p' }) // 只写暂存快照
    await h.result.onThinkingSelect('o') // 暂存档位
    expect(lookup('p/Y')).toBeUndefined() // staging 快照不入表
    expect(lookup('p/X')).toBe('high') // 源 session 记忆不变
    h.scope.stop()
  })

  it('R3/已建态入表：生效档位经 map 反查为 UI key 记录（D1 存 key 非 value），变化即更新', async () => {
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': { off: 'o', low: 'l', high: 'h' } },
      supported: { 'p/X': ['off', 'low', 'high'] },
    })
    expect(lookup('p/X')).toBe('high') // value 'h' → UI key 'high'
    h.sessionRef.value = { modelId: 'p/X', thinkingLevel: 'l' }
    await nextTick()
    expect(lookup('p/X')).toBe('low')
    h.scope.stop()
  })

  it('R4/体系外值拦截（E5 防线）：map 反查出的 key 不在模型可用集 → 不入表', async () => {
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      // map 含 max:'m'，但 supportedLevels 体系外不含 max——'m' 反查为 'max' 应被拦
      maps: { 'p/X': { off: 'o', high: 'h', max: 'm' } },
      supported: { 'p/X': ['off', 'high'] },
    })
    expect(lookup('p/X')).toBe('high')
    h.sessionRef.value = { modelId: 'p/X', thinkingLevel: 'm' }
    await nextTick()
    expect(lookup('p/X')).toBe('high') // 'max' 被可用性校验拦截，记忆保持
    h.scope.stop()
  })
})

// ══════════ [u5] 探针表补漏收口（设计 §3.3 探针表第 2/3 行缺口）══════════
describe('useComposerModelThinking · 探针表补漏（u5 收口）', () => {
  it('F4/已建态不受跟随影响：session 已建时跟随 watch 恒静默，localThinkingLevel 不被触碰（G3）', async () => {
    record('p/X', 'low') // 记忆存在——若跟随误入已建态会改写 local
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap() },
      supported: { 'p/X': fourLevels, 'p/Y': fourLevels },
    })
    expect(h.result.localThinkingLevel.value).toBeUndefined() // mount 即时跟随被 sid 门禁拦截
    // defaultModel 变化（landing 链路扰动源）与 session 模型变化均不得触发跟随
    h.defaultModelRef.value = 'p/N'
    await nextTick()
    expect(h.result.localThinkingLevel.value).toBeUndefined()
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'h' }
    await nextTick()
    expect(h.result.localThinkingLevel.value).toBeUndefined()
    h.scope.stop()
  })

  it('C1/探针第 3 行：pi 回执钳制（记忆 max → 实际生效 high）→ 记录 watch 把记忆收敛为钳制值', async () => {
    // Y：max 档可用（恢复会发出 max 的 value 'x'），pi 端把 max 钳制到 high（回执 value 'h2'）
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: {
        'p/X': sameContentMap(),
        'p/Y': { off: 'o', low: 'l', medium: 'm', high: 'h2', max: 'x' },
      },
      supported: { 'p/X': fourLevels, 'p/Y': [...fourLevels, 'max'] },
    })
    record('p/Y', 'max')
    const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' })
    h.pending[0].applyAndResolve('p/Y')
    await p
    // 恢复发出的是记忆 max 的 value 'x'（钳制发生在 pi 端，前端只发档位 value）
    expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'x')
    // 回执钳制值写入 store（U6：回执写 store，显示恒为真值）→ 记录 watch 以回执值反查更新记忆
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'h2' }
    await nextTick()
    // 收敛方向断言（探针第 3 行）：记忆最终 = 钳制后的生效档 'high'，而非原始记忆 'max'
    expect(lookup('p/Y')).toBe('high')
    expect(lookup('p/Y')).not.toBe('max')
    h.scope.stop()
  })

  it('N1/探针第 2 行幂等边界：非单射 map（high/max 同 value）反查一次归一漂移后到达不动点，无累积漂移', async () => {
    // 非单射 map：high 与 max 都映射 'x'——反查 value 'x' 按 entries 遍历序确定性落到 'high'
    const nonInjectiveMap = { off: 'o', low: 'l', high: 'x', max: 'x' }
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': sameContentMap(), 'p/Y': nonInjectiveMap },
      supported: { 'p/X': fourLevels, 'p/Y': [...fourLevels, 'max'] },
    })
    // 用户在 Y 上选 max（生效 value 'x'）→ 记录 watch 反查：一次归一漂移 max → 'high'
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'x' }
    await nextTick()
    expect(lookup('p/Y')).toBe('high')
    // 往返幂等：记忆 key 经同一 map 换算回 value 恒 'x'（恢复语义与用户原选择等效，无漂移放大）
    expect(resolveThinkingValue(lookup('p/Y')!, nonInjectiveMap)).toBe('x')
    // 第二轮往返（恢复 'high' → 生效 'x' → 再记录）：反查确定性 → 不动点，无累积漂移
    h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'x' }
    await nextTick()
    expect(lookup('p/Y')).toBe('high')
    h.scope.stop()
  })
})

// ══════════ [一致性审查第 1 轮修复] U-fix-1 / U-fix-2 ══════════
describe('useComposerModelThinking · 一致性审查修复（U-fix-1/2）', () => {
  it('UF1a/landing re-select 同模型不设 armed：后续 providers 无关刷新不覆写用户 authored 值', async () => {
    record('p/M', 'low') // 记忆可用且 ≠ 用户值——若 armed 误设，刷新会把 local 覆写为 'l'
    const h = mountLanding({ defaultModel: 'p/M' })
    expect(h.result.currentThinkingLevel.value).toBe('l') // 跟随先落记忆值
    await h.result.onThinkingSelect('h') // 用户显式选档 → authored
    // re-select 同模型：无反应性变化，watch 必不触发——armed 源头跳过（U-fix-1）
    await h.result.onModelSelect({ modelId: 'M', provider: 'p' })
    expect(h.setPendingModel).toHaveBeenCalledWith('p/M') // pendingModel 照常记
    // 人为触发一次无关 providers 变化：若 armed 悬留，规则 2 匹配分支会经 onReset
    // 写回记忆值 'l'（恢复通路不检查 localAuthored）= chip 突跳伪恢复（D3 规则 5 要消灭的形态）
    refreshProviderIdentity(h.providersRef, 'p/M')
    await nextTick()
    expect(h.result.currentThinkingLevel.value).toBe('h') // authored 值保持
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    h.scope.stop()
  })

  it('UF1b/staging re-select 同模型不设 armed：后续 providers 无关刷新不覆写暂存快照', async () => {
    const h = mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap() },
      supported: { 'p/X': fourLevels, 'p/Y': fourLevels },
    })
    record('p/X', 'low')
    h.result.enterStagingMode() // currentModelId 切读快照 'p/X'
    await h.result.onModelSelect({ modelId: 'X', provider: 'p' }) // re-select 同模型 → 不设 armed
    // 无关刷新：若 armed 悬留，规则 2 会 onReset('l') 写入 stagingThinking（伪恢复）
    refreshProviderIdentity(h.providersRef, 'p/X')
    await nextTick()
    expect(h.result.currentThinkingLevel.value).toBe('h') // 暂存快照保持
    expect(h.setThinkingLevel).not.toHaveBeenCalled()
    h.scope.stop()
  })

  it('UF2/跟随可用性校验（U-fix-2，D2 公式）：记忆键失效（不在可用集）→ 跟随回落最高可用档', async () => {
    // 记忆 'max' 存在，但 M 的 supportedLevels（fourLevels）不含 max——能力注册表变化场景
    record('p/M', 'max')
    const h = mountLanding({ defaultModel: 'p/M' })
    // 可用(lookup) ?? 最高档：'max' 失效 → 回落 'high'（经 map 映射 value 'h'），
    // 不短暂显示不可用档（E3/D5 可用性回落防线延伸到跟随路径）
    expect(h.result.currentThinkingLevel.value).toBe('h')
    h.scope.stop()
  })

  it('UF3/保留方向（R2-fix-2）：生产保真 harness 下 authored 后真实切换 M→N → armed 设立 → 恢复记忆值', async () => {
    // 生产保真前提：setPendingModel 同步写 currentModel（与 flow.ts 同构），re-select
    // 判定若错放在写之后，此处会因「恒 re-select」不 arm → 恢复失效 → 断言必红
    record('p/N', 'low')
    const h = mountLanding({ defaultModel: 'p/M' })
    expect(h.result.currentThinkingLevel.value).toBe('h') // M 无记忆 → 跟随落最高档
    await h.result.onThinkingSelect('h') // 用户 authored（置位 localAuthored）
    await h.result.onModelSelect({ modelId: 'N', provider: 'p' }) // 真实切换（非 re-select）
    await nextTick() // 等 sync watch flush 消费 armed
    // armed 已设立且被规则 2 消费：记忆 N='low' → onReset('l') → landing 分支写 local
    //（恢复通路不检查 localAuthored——显式切模型即恢复，authored 只冻结「跟随」）
    expect(h.result.currentThinkingLevel.value).toBe('l')
    expect(h.setPendingModel).toHaveBeenCalledWith('p/N') // pendingModel 照常记
    expect(h.setThinkingLevel).not.toHaveBeenCalled() // landing 无 RPC
    h.scope.stop()
  })
})

// ══════════ [U4] D3 显示分流：已建态空值占位（不回落 landing 残留/全局默认）══════════
describe('useComposerModelThinking · D3 显示分流（已建态空值占位）', () => {
  it('已建态 session.modelId 空串 → regularModelId 返回空串占位，不兜底到 currentModel/defaultModel', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: '' },
      currentModel: 'provider-F/model-F',
      defaultModel: 'provider-D/model-D',
    })
    // 空串 → '' 占位，不回落 landing currentModel 或全局 defaultModel
    expect(result.currentModelId.value).toBe('')
    scope.stop()
  })

  it('已建态 session.thinkingLevel undefined → regularThinkingLevel 返回 undefined，不回落 localThinkingLevel', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A' }, // thinkingLevel 缺失
    })
    // thinkingLevel undefined → undefined 占位，不回落 landing localThinkingLevel
    expect(result.currentThinkingLevel.value).toBeUndefined()
    scope.stop()
  })

  it('已建态 session.modelId 有值 → 正常返回（不被 D3 改变）', () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    expect(result.currentModelId.value).toBe('provider-A/model-A')
    expect(result.currentThinkingLevel.value).toBe('high')
    scope.stop()
  })

  it('landing 态（sessionId=null）→ 走兜底链，不受 D3 分流影响', () => {
    const { result, scope } = mount(null, {
      currentModel: 'provider-F/model-F',
      defaultModel: 'provider-D/model-D',
    })
    expect(result.currentModelId.value).toBe('provider-F/model-F')
    scope.stop()
  })
})

// ══════════ [U4] D4 lastUsedModel 兜底链（landing 态 modelId 兜底链顺序）══════════
describe('useComposerModelThinking · D4 lastUsedModel 兜底链', () => {
  it('landing + currentModel null + lastUsedModel 有值 → 读 lastUsedModel', () => {
    recordLastUsed('provider-L/model-L')
    const { result, scope } = mount(null, {
      defaultModel: 'provider-D/model-D',
    })
    // currentModel null → lastUsedModel → defaultModel
    expect(result.currentModelId.value).toBe('provider-L/model-L')
    scope.stop()
  })

  it('landing + currentModel 有值 → 优先读 currentModel（lastUsedModel 不干扰）', () => {
    recordLastUsed('provider-L/model-L')
    const { result, scope } = mount(null, {
      currentModel: 'provider-F/model-F',
      defaultModel: 'provider-D/model-D',
    })
    // currentModel 优先级最高
    expect(result.currentModelId.value).toBe('provider-F/model-F')
    scope.stop()
  })

  it('landing + currentModel null + lastUsedModel 无记录 → 回落 defaultModel', () => {
    // lastUsedModel 未记录 → undefined
    const { result, scope } = mount(null, {
      defaultModel: 'provider-D/model-D',
    })
    expect(result.currentModelId.value).toBe('provider-D/model-D')
    scope.stop()
  })
})

// ══════════ [U4] D4 lastUsedModel 写入（显式选择写 KV，staging 不写）══════════
describe('useComposerModelThinking · D4 lastUsedModel 写入', () => {
  it('已建态 onModelSelect → 写入 lastUsedModel', async () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(lookupLastUsed()).toBe('provider-C/model-C')
    scope.stop()
  })

  it('landing 态 onModelSelect → 写入 lastUsedModel', async () => {
    const { result, scope } = mount(null)
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(lookupLastUsed()).toBe('provider-C/model-C')
    scope.stop()
  })

  it('staging 态 onModelSelect → 不写 lastUsedModel', async () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    result.enterStagingMode()
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    // staging 试选不写 KV
    expect(lookupLastUsed()).toBeUndefined()
    scope.stop()
  })

  it('多次选择 → lastUsedModel 覆盖为最后一次', async () => {
    const { result, scope } = mount('s1', {
      sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
    })
    await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' })
    expect(lookupLastUsed()).toBe('provider-B/model-B')
    await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' })
    expect(lookupLastUsed()).toBe('provider-C/model-C')
    scope.stop()
  })
})
