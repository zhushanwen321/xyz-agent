/**
 * 思考等级与模型同步 composable（Q3）。
 *
 * 从 Composer 拆出，保持 script setup 行数合规。职责：
 * - 按 currentModelId 解析当前模型的 thinkingLevelMap
 * - 模型切换后若当前思考等级不在新模型可用档位，重置到最高可用档
 *
 * thinkingLevelMap 语义：
 * key = UI 可选档位（ThinkingLevel 枚举值，含 max），value = 发给 runtime/pi 的实际 level。
 * onReset 传给 Composer 的是 map 映射后的 value（发给 runtime 的字符串）。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import {
  resolveAvailableLevels,
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
} from '@/components/panel/thinking-levels'

export function useThinkingLevelSync(
  currentModelId: ComputedRef<string> | Ref<string>,
  currentThinkingLevel: ComputedRef<string | undefined>,
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

  /**
   * 模型切换后对齐思考等级（session 已建 + landing 态均触发）。
   *
   * immediate：Composer 挂载时 currentThinkingLevelMap 首次求值即触发——landing 态
   * 初始 localThinkingLevel=undefined，需立即设为当前模型最高可用档；session 已建时
   * currentThinkingLevel 有值，若可用则不重置，不可用则重置（首次也对齐）。
   *
   * - currentThinkingLevel 有值（session 已建 或 landing 态已设 localThinkingLevel）：
   *   反查为 UI key，若不在新模型可用档位 → 重置到最高可用档
   * - currentThinkingLevel 无值（landing 态初始）：
   *   直接设为最高可用档（新模型的默认思考强度）
   *
   * onReset 传的是 map 映射后的 value（发给 runtime/pi 的字符串）。
   */
  watch(currentThinkingLevelMap, (map) => {
    const current = currentThinkingLevel.value
    if (!current) {
      // landing 态初始无思考等级 → 设为新模型最高可用档
      const highest = highestAvailableLevel(map)
      onReset(resolveThinkingValue(highest, map))
      return
    }
    // current 是 runtime 返回的 value，反查为 UI key 再判可用性
    const currentKey = resolveThinkingKey(current, map)
    const available = resolveAvailableLevels(map)
    if (!available.includes(currentKey)) {
      const highest = highestAvailableLevel(map)
      onReset(resolveThinkingValue(highest, map))
    }
  }, { immediate: true })

  return currentThinkingLevelMap
}
