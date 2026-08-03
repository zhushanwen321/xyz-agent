/**
 * useComposerModelThinking —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/model-thinking.ts（W3）。
 * core 版重构签名为 (sessionId, deps)，7 个跨域能力经 deps 注入（core 零 renderer import）。
 * 本 shim 保持旧签名（1 参），内部从 renderer store/composable 组装 7 deps 调 core 版。
 *
 * 旧调用方（Composer.vue）零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useModel } from '@/composables/features/useModel'
import {
  useComposerModelThinking as useCoreComposerModelThinking,
  type ModelThinkingDeps,
} from '@xyz-agent/core/domain/composer'

export function useComposerModelThinking(
  sessionId: Parameters<typeof useCoreComposerModelThinking>[0],
) {
  const sessionStore = useSessionStore()
  const settingsStore = useSettingsStore()
  const flow = useNewTaskFlow()
  const { switchModel, setThinkingLevel } = useModel()

  const deps: ModelThinkingDeps = {
    getSessionState: (sid: string) => {
      const s = sessionStore.list.find((x) => x.id === sid)
      if (!s) return null
      return { modelId: s.modelId, thinkingLevel: s.thinkingLevel }
    },
    defaultModel: settingsStore.defaultModel,
    currentModel: flow.currentModel,
    setPendingModel: (model: string) => flow.setPendingModel(model),
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: (modelId: string) => {
      // 旧版守卫：无 '/' 的 modelId（如空串/非完整模型 id）直接返回 undefined（all-levels），
      // 不碰 providers（测试 mock 的 settingsStore 可能无 providers，见 composer-file-injection 测试）。
      if (!modelId.includes('/')) return undefined
      const [providerId, modelName] = modelId.split('/')
      const provider = settingsStore.providers?.find((p: { id: string }) => p.id === providerId)
      return provider?.models.find((m: { id: string }) => m.id === modelName)?.thinkingLevelMap
    },
  }

  return useCoreComposerModelThinking(sessionId, deps)
}
