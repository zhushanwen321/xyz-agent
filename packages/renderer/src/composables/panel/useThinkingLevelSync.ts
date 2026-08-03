/**
 * useThinkingLevelSync —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/thinking-level-sync.ts（W3）。
 * core 版把 settingsStore.providers 读取改为 ThinkingLevelSyncDeps.getThinkingLevelMap
 * 注入字段（core 零 renderer import）。本 shim 保持旧签名（3 参），内部从
 * useSettingsStore 派生 getThinkingLevelMap 组装 deps 调 core 版。
 *
 * 旧调用方（model-thinking shim / Composer.vue）零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { useSettingsStore } from '@/stores/settings'
import { useThinkingLevelSync as useCoreThinkingLevelSync } from '@xyz-agent/core/domain/composer'

export function useThinkingLevelSync(
  currentModelId: Parameters<typeof useCoreThinkingLevelSync>[0],
  currentThinkingLevel: Parameters<typeof useCoreThinkingLevelSync>[1],
  onReset: (level: string) => void,
) {
  const settingsStore = useSettingsStore()
  return useCoreThinkingLevelSync(currentModelId, currentThinkingLevel, onReset, {
    getThinkingLevelMap: (modelId: string) => {
      // 旧版守卫：无 '/' 的 modelId 直接返回 undefined（all-levels），不碰 providers
      if (!modelId.includes('/')) return undefined
      const [providerId, modelName] = modelId.split('/')
      const provider = settingsStore.providers?.find((p: { id: string }) => p.id === providerId)
      return provider?.models.find((m: { id: string }) => m.id === modelName)?.thinkingLevelMap
    },
  })
}
