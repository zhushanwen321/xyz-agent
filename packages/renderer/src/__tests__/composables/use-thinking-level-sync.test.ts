/**
 * useThinkingLevelSync 切模型重置逻辑测试。
 *
 * 映射规则（用户确认语义）：同体系直接映射，跨体系重置到目标模型最高可用档。
 * 「体系」= 可用档位 key 集合相同（isSameThinkingScheme）。
 *
 * 数据（对齐真实配置 / useProviderEdit THINKING_PRESETS）：
 * - high-max 模型 map = { off:'off', high:'high', max:'xhigh' }（可用 off+high+max，max 档发 xhigh）
 * - on-off 模型 map   = { off:'off', high:'high' }（可用 off+high）
 * - all-levels map    = undefined（全档可用）
 *
 * onReset 传的是 map 映射后的 value（如 max 档发 xhigh），不是 key。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/use-thinking-level-sync.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useThinkingLevelSync } from '@/composables/panel/useThinkingLevelSync'
import { useSettingsStore } from '@/stores/settings'

// 真实预设（对齐 useProviderEdit THINKING_PRESETS）
const HIGH_MAX_MAP = { off: 'off', minimal: null, low: null, medium: null, high: 'high', max: 'xhigh' }
const ON_OFF_MAP = { off: 'off', minimal: null, low: null, medium: null, high: 'high', xhigh: null }

function makeProvider(id: string, models: Array<{ id: string; thinkingLevelMap?: Record<string, string | null> }>) {
  return { id, name: id, apiKeySet: false, status: 'not_configured' as const, models }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useThinkingLevelSync · 切模型自动重置思考等级', () => {
  it('A(high-max, level=xhigh) → B(on-off)：重置为 high（on-off 最高可用档的 value）', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: HIGH_MAX_MAP },
        { id: 'B', thinkingLevelMap: ON_OFF_MAP },
      ]),
    ]

    const currentModelId = ref('p/A')
    // A 模型选了 max 档（发 value='xhigh'），session.thinkingLevel='xhigh'
    const currentThinkingLevel = ref<string | undefined>('xhigh')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（on-off）
    currentModelId.value = 'p/B'
    await nextTick()

    // 期望：onReset 被调，参数是 high（on-off 最高可用档 high 的 value='high'）
    expect(resetCalls).toEqual(['high'])
  })

  it('A(high-max, level=high) → B(on-off)：high 在 on-off 可用，不重置', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: HIGH_MAX_MAP },
        { id: 'B', thinkingLevelMap: ON_OFF_MAP },
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（on-off）
    currentModelId.value = 'p/B'
    await nextTick()

    // high 在 on-off 的可用档位里（key=high, value='high'），不重置
    expect(resetCalls).toEqual([])
  })

  it('landing 态（level=undefined）切模型：直接设为最高可用档', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [{ id: 'B', thinkingLevelMap: ON_OFF_MAP }]),
    ]

    const currentModelId = ref('p/B')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // currentThinkingLevel=undefined → 直接设为最高可用档
    // on-off 最高可用档 = high，value='high'
    expect(resetCalls).toEqual(['high'])
  })

  it('切到 all-levels 模型（map=undefined）：跨体系 → 重置到 max（all-levels 最高档）', async () => {
    // 体系判定：on-off({off,high}) vs all-levels(全 6 档) → 跨体系 → 重置到最高档 max
    // 语义变化：原逻辑判 high 在 all-levels 可用就不重置；新逻辑跨体系一律重置到最高档
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: ON_OFF_MAP },
        { id: 'C' }, // all-levels（无 map）
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 all-levels 模型
    currentModelId.value = 'p/C'
    await nextTick()

    // 跨体系 → 重置到 all-levels 最高档 max，value='max'（all-levels 发 key 自身）
    expect(resetCalls).toEqual(['max'])
  })
})

describe('useThinkingLevelSync · 体系判定（同体系直接映射 / 跨体系重置到最高档）', () => {
  it('A(on-off, level=high 即"on") → B(high-max)：跨体系 → 重置到 max（value=xhigh）', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: ON_OFF_MAP },
        { id: 'B', thinkingLevelMap: HIGH_MAX_MAP },
      ]),
    ]

    const currentModelId = ref('p/A')
    // A(on-off) 选了 high 档（"on"），value='high'
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（high-max）——跨体系（{off,high} ≠ {off,high,max}）
    currentModelId.value = 'p/B'
    await nextTick()

    // 期望：重置到 high-max 最高档 max，value='xhigh'
    expect(resetCalls).toEqual(['xhigh'])
  })

  it('A(on-off) → B(on-off)：同体系 → 直接映射，不重置', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: ON_OFF_MAP },
        { id: 'B', thinkingLevelMap: ON_OFF_MAP },
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（同为 on-off）——同体系
    currentModelId.value = 'p/B'
    await nextTick()

    // 同体系，value 未变（high→high），不重置
    expect(resetCalls).toEqual([])
  })

  it('A(high-max, level=high) → B(high-max)：同体系 → 直接映射，不重置', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: HIGH_MAX_MAP },
        { id: 'B', thinkingLevelMap: HIGH_MAX_MAP },
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（同为 high-max）——同体系
    currentModelId.value = 'p/B'
    await nextTick()

    // 同体系，value 未变（high→high），不重置
    expect(resetCalls).toEqual([])
  })

  it('A(all-levels) → B(all-levels)：同体系 → 直接映射，不重置', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A' }, // all-levels
        { id: 'B' }, // all-levels
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('medium')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（同为 all-levels）——同体系
    currentModelId.value = 'p/B'
    await nextTick()

    // 同体系，value 未变（medium→medium），不重置
    expect(resetCalls).toEqual([])
  })

  it('A(on-off) → B(all-levels)：跨体系 → 重置到 max', async () => {
    const settings = useSettingsStore()
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: ON_OFF_MAP },
        { id: 'B' }, // all-levels
      ]),
    ]

    const currentModelId = ref('p/A')
    const currentThinkingLevel = ref<string | undefined>('high')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B（all-levels）——跨体系（{off,high} ≠ 全 6 档）
    currentModelId.value = 'p/B'
    await nextTick()

    // 期望：重置到 all-levels 最高档 max，value='max'（all-levels 发 key 自身）
    expect(resetCalls).toEqual(['max'])
  })

  it('同体系但 value 不同：A(max→xhigh) → B(max→ultrathink) → 重置 value 为 ultrathink', async () => {
    const settings = useSettingsStore()
    const MAP_A = { off: 'off', high: 'high', max: 'xhigh' }
    const MAP_B = { off: 'off', high: 'high', max: 'ultrathink' }
    settings.providers = [
      makeProvider('p', [
        { id: 'A', thinkingLevelMap: MAP_A },
        { id: 'B', thinkingLevelMap: MAP_B },
      ]),
    ]

    const currentModelId = ref('p/A')
    // A 选了 max 档，value='xhigh'
    const currentThinkingLevel = ref<string | undefined>('xhigh')
    const resetCalls: string[] = []
    const map = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      (level) => { resetCalls.push(level) },
    )
    void map.value
    await nextTick()

    // 切到 B——同体系（key 集合相同），但 max 档 value 从 xhigh 变成 ultrathink
    currentModelId.value = 'p/B'
    await nextTick()

    // 期望：同体系直接映射，但 value 变了 → 重置为 B 的 max 档 value 'ultrathink'
    expect(resetCalls).toEqual(['ultrathink'])
  })
})
