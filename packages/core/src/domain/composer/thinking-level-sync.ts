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
 * - [U6] 可用档判定切 deps.getSupportedLevels（ProviderInfo.models[].supportedLevels，
 *   runtime 注册表 pi 同源计算下发），本地推算已删除。
 * - import 路径 `@/components/panel/thinking-levels` → core 本域 `./thinking-levels`（batch1 已迁入）。
 * 函数签名 / 逻辑 byte-level 保持。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import {
  normalizeSupportedLevels,
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
   * 取指定 modelId 的档位可用集（ProviderInfo.models[].supportedLevels，U6 切源——
   * runtime 能力注册表 pi 同源计算的 view-ready 下发）。undefined = 下发链路未接通
   * （归一为默认五档）。non-reasoning 模型该集为 ['off']——切模型重置逻辑据此正确落到 off。
   */
  getSupportedLevels: (modelId: string) => string[] | undefined
}

export function useThinkingLevelSync(
  currentModelId: ComputedRef<string> | Ref<string>,
  currentThinkingLevel: ComputedRef<string | undefined>,
  onReset: (level: string) => void,
  deps: ThinkingLevelSyncDeps,
): ComputedRef<Record<string, string | null> | undefined> {
  /** 当前模型的思考档位映射（按 currentModelId 经 deps 派生） */
  const currentThinkingLevelMap = computed(() => deps.getThinkingLevelMap(currentModelId.value))

  /** 当前模型档位可用集（supportedLevels，U6 切源——可用档判定唯一权威） */
  const supportedOf = () => deps.getSupportedLevels(currentModelId.value)

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
  watch(
    // 组合观察源：map（key→value 映射）+ supportedLevels（可用档集，U6 切源）。
    // 一起观察让回调同时拿到新旧 supported——体系判定（isSameThinkingScheme）需要
    // 切换前后两个模型的档位集，单观察 map 拿不到旧模型的 supported。
    () => [currentThinkingLevelMap.value, supportedOf()] as const,
    ([map, supported], oldPair) => {
    const oldMap = oldPair?.[0]
    const oldSupported = oldPair?.[1]
    const current = currentThinkingLevel.value
    if (!current) {
      // landing 态初始无思考等级 → 设为新模型最高可用档
      const highest = highestAvailableLevel(supported)
      onReset(resolveThinkingValue(highest, map))
      return
    }
    // 首次触发（无 oldMap 可比）→ 可用性检查，与原逻辑一致
    if (oldMap === undefined) {
      const currentKey = resolveThinkingKey(current, map, highestAvailableLevel(supported))
      const available = normalizeSupportedLevels(supported)
      if (!available.includes(currentKey)) {
        const highest = highestAvailableLevel(supported)
        onReset(resolveThinkingValue(highest, map))
      }
      return
    }
    // 模型切换：同体系 → 直接映射当前档位 key 到新模型 value
    if (isSameThinkingScheme(oldSupported, supported)) {
      const currentKey = resolveThinkingKey(current, oldMap)
      // 防御：current 既不在 oldMap 的 value 里又非合法 ThinkingLevel 时，
      // resolveThinkingKey 缺省 fallback 到默认五档最高档；该 key 若在新模型的
      // 可用档中不可用，resolveThinkingValue 会走 v ?? key 回退把不可用档原样发给
      // runtime。此时走跨体系重置（重置到最高可用档）。
      const available = normalizeSupportedLevels(supported)
      if (!available.includes(currentKey)) {
        const highest = highestAvailableLevel(supported)
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
    const highest = highestAvailableLevel(supported)
    const newValue = resolveThinkingValue(highest, map)
    if (newValue !== current) onReset(newValue)
  }, { immediate: true })

  return currentThinkingLevelMap
}
