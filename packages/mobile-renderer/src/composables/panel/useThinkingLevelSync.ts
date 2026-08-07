/**
 * 思考等级与模型同步 composable（Q3）。
 *
 * 从 Composer 拆出，保持 script setup 行数合规。职责：
 * - 按 currentModelId 解析当前模型的 thinkingLevelMap
 * - 模型切换后按体系判定对齐思考等级：同体系直接映射，跨体系重置到最高可用档
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
  isSameThinkingScheme,
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
   * 映射规则（用户确认的语义）：
   * 1. currentThinkingLevel 无值（landing 态初始）→ 设为新模型最高可用档
   * 2. 首次触发（oldMap===undefined，Composer 挂载/session 载入）→ 可用性检查：
   *    当前档位在新模型可用则保留，不可用则重置到最高档（与原逻辑一致，避免无 oldMap
   *    无法判定体系时误触发冗余 RPC）
   * 3. 真正的模型切换（oldMap 有值）→ 体系判定：
   *    - 同体系（可用 key 集合相同）→ 直接映射当前档位到新模型 value
   *    - 跨体系 → 重置到新模型最高可用档
   *
   * 「体系」定义见 isSameThinkingScheme。同体系时用旧 map 反查当前 value 的 UI key，
   * 再用新 map 转成新 value；value 未变则不触发冗余 RPC。
   *
   * onReset 传的是 map 映射后的 value（发给 runtime/pi 的字符串）。
   */
  watch(currentThinkingLevelMap, (map, oldMap) => {
    const current = currentThinkingLevel.value
    if (!current) {
      // landing 态初始无思考等级 → 设为新模型最高可用档
      const highest = highestAvailableLevel(map)
      onReset(resolveThinkingValue(highest, map))
      return
    }
    // 首次触发（无 oldMap 可比）→ 可用性检查，与原逻辑一致
    if (oldMap === undefined) {
      const currentKey = resolveThinkingKey(current, map)
      const available = resolveAvailableLevels(map)
      if (!available.includes(currentKey)) {
        const highest = highestAvailableLevel(map)
        onReset(resolveThinkingValue(highest, map))
      }
      return
    }
    // 模型切换：同体系 → 直接映射当前档位 key 到新模型 value
    if (isSameThinkingScheme(oldMap, map)) {
      const currentKey = resolveThinkingKey(current, oldMap)
      // 防御：current 既不在 oldMap 的 value 里又非合法 ThinkingLevel 时，
      // resolveThinkingKey 会 fallback 到 'max'；若新 map 不含 max 档，
      // resolveThinkingValue('max', map) 会走 v ?? key 回退返回字符串 'max'，
      // 静默发给 runtime 一个该模型不可用的档位。此时走跨体系重置（重置到最高可用档）。
      const available = resolveAvailableLevels(map)
      if (!available.includes(currentKey)) {
        const highest = highestAvailableLevel(map)
        const resetValue = resolveThinkingValue(highest, map)
        if (resetValue !== current) onReset(resetValue)
        return
      }
      const newValue = resolveThinkingValue(currentKey, map)
      // value 变了才重置（同体系同 value 时不触发冗余 RPC）
      if (newValue !== current) onReset(newValue)
      return
    }
    // 跨体系 → 重置到新模型最高可用档（value 未变则不触发冗余 RPC）
    const highest = highestAvailableLevel(map)
    const newValue = resolveThinkingValue(highest, map)
    if (newValue !== current) onReset(newValue)
  }, { immediate: true })

  return currentThinkingLevelMap
}
