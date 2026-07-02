/**
 * useThinkingLevelSync 切模型重置逻辑测试。
 *
 * 核心场景（用户反馈）：landing 态从 A 模型（high-max）切到 B 模型（on-off），
 * 思考等级应自动从 max 重置为 high（on-off 最高可用档），而非停留在 max。
 *
 * 数据（对齐真实配置 / ProviderEditModal THINKING_PRESETS）：
 * - high-max 模型 map = { high:'high', max:'xhigh' }（可用 high + max，max 档发 xhigh）
 * - on-off 模型 map   = { off:'off', high:'high' }（可用 off + high，high 档发 high）
 * - all-levels map    = undefined（全档可用）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/use-thinking-level-sync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useThinkingLevelSync } from '@/composables/panel/useThinkingLevelSync'
import { useSettingsStore } from '@/stores/settings'

// 真实预设（对齐 ProviderEditModal THINKING_PRESETS）
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
    // 触发 computed 求值
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
    // A 模型选了 high 档（发 value='high'）
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
    // landing 态初始无 thinkingLevel
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

  it('切到 all-levels 模型（map=undefined）：全档可用，不重置', async () => {
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

    // all-levels 全档可用，high 仍可用，不重置
    expect(resetCalls).toEqual([])
  })
})
