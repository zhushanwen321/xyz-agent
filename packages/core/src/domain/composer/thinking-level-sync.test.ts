/**
 * useThinkingLevelSync 单元测试。
 *
 * 被测对象：domain/composer/thinking-level-sync.ts —— 思考等级与模型同步 composable。
 * 职责：currentThinkingLevelMap 派生（经 deps.getThinkingLevelMap）+ 切模型后按体系对齐思考等级。
 *
 * 策略：mock deps.getThinkingLevelMap 为 vi.fn，按 modelId 返回可控 map；
 * currentModelId / currentThinkingLevel 用 ref 驱动；onReset 用 vi.fn 记录调用。
 *
 * watch 配置 `{ immediate: true }`，默认 flush 'pre'（异步）：
 * - immediate 首次回调在 useThinkingLevelSync 调用时同步执行（断言无需 await）
 * - 后续 currentModelId 变化触发的回调异步（await nextTick 等待 flush）
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/thinking-level-sync.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useThinkingLevelSync, type ThinkingLevelSyncDeps } from './thinking-level-sync'

// 体系 A：off+high 两档
const mapA = { off: 'o', high: 'h' }
// 体系 A'：同 key 集合（off+high），value 不同 —— 与 A 同体系
const mapASame = { off: 'o2', high: 'h2' }
// 体系 B：low+medium 两档 —— 与 A 跨体系
const mapB = { low: 'l', medium: 'm' }

describe('useThinkingLevelSync', () => {
  it('case1: currentThinkingLevel 无值 → 设新模型最高可用档（immediate 同步）', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : undefined)),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    // highestAvailableLevel(mapA) = 'high'；resolveThinkingValue('high', mapA) = 'h'
    expect(onReset).toHaveBeenCalledWith('h')
  })

  it('case2: 同体系切换 → 映射迁移当前档位 value', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => {
        if (id === 'p/m1') return mapA
        if (id === 'p/m2') return mapASame
        return undefined
      }),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    // immediate：current undefined → onReset('h')
    expect(onReset).toHaveBeenCalledWith('h')

    // 模拟 session 载入/用户选档 → current 有值
    currentThinkingLevel.value = 'h'
    // 切到同体系模型 → map: mapA → mapASame
    currentModelId.value = 'p/m2'
    await nextTick()
    // isSameThinkingScheme(mapA, mapASame) = true（key 集合相同）
    // currentKey = resolveThinkingKey('h', mapA) = 'high'
    // newValue = resolveThinkingValue('high', mapASame) = 'h2'；'h2' !== 'h' → onReset('h2')
    expect(onReset).toHaveBeenCalledWith('h2')
  })

  it('case3: 跨体系切换 → 重置到新模型最高可用档', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => {
        if (id === 'p/m1') return mapA
        if (id === 'p/m3') return mapB
        return undefined
      }),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    // immediate：current 'h' 有值，oldMap undefined → 第二分支可用性检查
    // resolveThinkingKey('h', mapA) = 'high'；available(mapA) = ['off','high'] includes 'high' → 不重置
    expect(onReset).not.toHaveBeenCalled()

    // 切到跨体系模型
    currentModelId.value = 'p/m3'
    await nextTick()
    // isSameThinkingScheme(mapA, mapB) = false（新语义可用集：['off','high'] vs 五档）
    // 跨体系：highestAvailableLevel(mapB) = 'high'（叠加规则 off..high）；
    // resolveThinkingValue('high', mapB) = 'high'（mapB 无 high key 回退 key 自身）
    // 'high' !== 'h' → onReset('high')
    expect(onReset).toHaveBeenCalledWith('high')
  })

  it('case4: 无 newMap（getThinkingLevelMap 返回 undefined）+ current 有值 → 不重置', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('high')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => undefined),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    // immediate：current 'high' 有值，oldMap undefined → 第二分支
    // resolveThinkingKey('high', undefined) = 'high'（isThinkingLevel 直接命中）
    // available(undefined) = 全 6 档 includes 'high' → true → 不重置
    expect(onReset).not.toHaveBeenCalled()
  })

  it('currentThinkingLevelMap 派生：返回 deps.getThinkingLevelMap 结果', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => mapA),
    }
    const currentThinkingLevelMap = useThinkingLevelSync(
      currentModelId,
      currentThinkingLevel,
      onReset,
      deps,
    )
    expect(currentThinkingLevelMap.value).toBe(mapA)
    // 切 modelId 后派生刷新
    currentModelId.value = 'p/m9'
    expect(currentThinkingLevelMap.value).toBe(mapA) // mock 恒返回 mapA
    expect(deps.getThinkingLevelMap).toHaveBeenCalledWith('p/m9')
  })

  it('U11: 切到 non-reasoning 模型（getModelReasoning=false）→ 重置到 off', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : undefined)),
      getModelReasoning: vi.fn((id: string) => (id === 'p/nonreasoning' ? false : true)),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    // 切到 non-reasoning 模型：可用档只有 ['off']，当前 'h' 不可用
    currentModelId.value = 'p/nonreasoning'
    await nextTick()
    // highestAvailableLevel(undefined, false) = 'off'；resolveThinkingValue('off', undefined) = 'off'
    expect(onReset).toHaveBeenCalledWith('off')
  })

  it('U11b: 切到 map 缺失模型（pi 默认五档）→ 当前不可用档重置到 high 而非 max', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('xhigh') // mimo 无此档
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => undefined), // xiaomi-token-plan-cn/mimo-v2.5-pro 场景
      getModelReasoning: vi.fn(() => true),
    }
    useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, deps)
    currentModelId.value = 'p/mimo'
    await nextTick()
    // 新语义可用集五档（无 max），最高可用档 = high → onReset('high')
    expect(onReset).toHaveBeenCalledWith('high')
  })
})
