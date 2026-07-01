/**
 * 思考等级与模型同步 composable（Q3）。
 *
 * 从 Composer 拆出，保持 script setup 行数合规。职责：
 * - 按 currentModelId 解析当前模型的 thinkingLevelMap
 * - 模型切换后若当前思考等级不在新模型可用档位，调 onReset 重置到最高可用档
 *
 * thinkingLevelMap 语义：value 非 null = 可用，value 值 = 发给 pi 的实际 level。
 * key 空间（含 minimal/off）与 ThinkingLevel 枚举（含 max）不一致，按 value 判定。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { resolveAvailableLevels, highestAvailableLevel, isThinkingLevel } from '@/components/panel/thinking-levels'

export function useThinkingLevelSync(
  currentModelId: ComputedRef<string> | Ref<string>,
  currentThinkingLevel: ComputedRef<string | undefined>,
  sessionId: ComputedRef<string | null> | Ref<string | null>,
  onReset: (level: string) => void,
): ComputedRef<Record<string, string | null> | undefined> {
  const settingsStore = useSettingsStore()

  /** 当前模型的思考档位映射（按 currentModelId 从 providers 解析） */
  const currentThinkingLevelMap = computed(() => {
    const id = currentModelId.value
    const sep = id.lastIndexOf('/')
    if (sep < 0) return undefined
    const providerId = id.slice(0, sep)
    const modelId = id.slice(sep + 1)
    const provider = settingsStore.providers.find((p) => p.id === providerId)
    return provider?.models.find((m) => m.id === modelId)?.thinkingLevelMap
  })

  /** 模型切换后若当前等级不可用，重置到最高可用档 */
  watch(currentThinkingLevelMap, (map) => {
    if (!sessionId.value) return
    const current = currentThinkingLevel.value
    if (!current || !isThinkingLevel(current)) return
    const available = resolveAvailableLevels(map)
    if (!available.includes(current)) {
      onReset(highestAvailableLevel(map))
    }
  })

  return currentThinkingLevelMap
}
