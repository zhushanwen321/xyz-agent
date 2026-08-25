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
 *
 * [W3 迁移] 迁自 renderer composables/panel/useThinkingLevelSync.ts。改动：
 * - 去掉 renderer 跨域依赖 `import { useSettingsStore } from '@/stores/settings'`，以及
 *   currentThinkingLevelMap computed 内联的 providers/models 解析逻辑。改为经
 *   deps.getThinkingLevelMap 回调注入（壳层 Composer 从 settingsStore.providers 派生后传入），
 *   core 零 store 依赖。
 * - import 路径 `@/components/panel/thinking-levels` → core 本域 `./thinking-levels`（batch1 已迁入）。
 * 函数签名 / 逻辑 byte-level 保持。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import {
  resolveAvailableLevels,
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
  isSameThinkingScheme,
} from './thinking-levels'

/** useThinkingLevelSync 的注入依赖：按 modelId 派生 thinkingLevelMap（壳层从 settingsStore.providers 解析注入）。 */
export interface ThinkingLevelSyncDeps {
  /**
   * 取指定 modelId 的 thinkingLevelMap。
   * @param modelId 完整 model id（provider/model 形式）
   * @returns 该模型的思考档位映射；undefined 表示无 map
   */
  getThinkingLevelMap: (modelId: string) => Record<string, string | null> | undefined
  /**
   * 取指定 modelId 是否支持思考（models[].reasoning）。可选：未注入时按 undefined（视为支持）判定。
   * non-reasoning 模型的可用档位只有 off——切模型重置逻辑需要此信息才能正确落到 off。
   */
  getModelReasoning?: (modelId: string) => boolean | undefined
}

export function useThinkingLevelSync(
  currentModelId: ComputedRef<string> | Ref<string>,
  currentThinkingLevel: ComputedRef<string | undefined>,
  onReset: (level: string) => void,
  deps: ThinkingLevelSyncDeps,
): ComputedRef<Record<string, string | null> | undefined> {
  /** 当前模型的思考档位映射（按 currentModelId 经 deps 派生） */
  const currentThinkingLevelMap = computed(() => deps.getThinkingLevelMap(currentModelId.value))

  /** 当前模型 reasoning 标志（non-reasoning 模型可用档只有 off） */
  const reasoningOf = () => deps.getModelReasoning?.(currentModelId.value)

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
      const highest = highestAvailableLevel(map, reasoningOf())
      onReset(resolveThinkingValue(highest, map))
      return
    }
    // 首次触发（无 oldMap 可比）→ 可用性检查，与原逻辑一致
    if (oldMap === undefined) {
      const currentKey = resolveThinkingKey(current, map)
      const available = resolveAvailableLevels(map, reasoningOf())
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
      const available = resolveAvailableLevels(map, reasoningOf())
      if (!available.includes(currentKey)) {
        const highest = highestAvailableLevel(map, reasoningOf())
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
    const highest = highestAvailableLevel(map, reasoningOf())
    const newValue = resolveThinkingValue(highest, map)
    if (newValue !== current) onReset(newValue)
  }, { immediate: true })

  return currentThinkingLevelMap
}
