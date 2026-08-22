/**
 * useScopedModels —— Scoped Model 配置业务编排。
 *
 * 读 settingsStore.scopedModels + providers 派生渲染数据；操作函数调 RPC
 * （乐观更新 + 失败回滚，参照 ProviderPage.vue:432-456 onToggleEnabled 范式）。
 *
 * 数据流：
 *   settingsStore.scopedModels → scopedRenderItems（渲染列表）
 *   settingsStore.providers + settingsStore.models → selectableModels（添加面板全量可选）
 *   add/remove/move → config.setScopedModels（乐观 + 回滚）
 *
 * 依赖方向：@xyz-agent/shared 类型 + @/api(config) + settingsStore。
 */
import { computed } from 'vue'
import { getSettingsStore } from '@xyz-agent/core'
import { config } from '@/api'
import type { ScopedRenderItem, SelectableModel } from '@xyz-agent/ui/features/settings'

export function useScopedModels() {
  const settingsStore = getSettingsStore()

  // ── 渲染数据：scopedModels 字符串列表 → ScopedRenderItem[] ──

  const scopedRenderItems = computed<ScopedRenderItem[]>(() => {
    const scoped = settingsStore.scopedModels.value
    if (!scoped.length) return []
    const providers = settingsStore.providers.value

    return scoped.map((fullId) => {
      const slashIdx = fullId.indexOf('/')
      if (slashIdx === -1) return { scoped: fullId, modelName: fullId, providerName: '', apiKeySet: true, missing: true }

      const providerId = fullId.substring(0, slashIdx)
      const modelId = fullId.substring(slashIdx + 1)
      const provider = providers.find((p) => p.id === providerId)

      if (!provider) return { scoped: fullId, modelName: modelId, providerName: providerId, apiKeySet: true, missing: true }

      const model = provider.models.find((m) => m.id === modelId)
      return {
        scoped: fullId,
        modelName: model?.name ?? modelId,
        providerName: provider.name,
        apiKeySet: provider.apiKeySet,
        missing: !model,
      }
    })
  })

  // ── 全量可选模型（添加面板数据源） ──

  const selectableModels = computed<SelectableModel[]>(() => {
    const providers = settingsStore.providers.value
    const result: SelectableModel[] = []
    for (const p of providers) {
      for (const m of p.models) {
        result.push({
          fullId: `${p.id}/${m.id}`,
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          name: m.name,
          apiKeySet: p.apiKeySet,
        })
      }
    }
    return result
  })

  // ── 操作函数（乐观更新 + 失败回滚） ──

  /** 添加模型到 scoped 列表（去重保序）。 */
  async function addScopedModels(models: string[]): Promise<void> {
    const old = [...settingsStore.scopedModels.value]
    const existing = new Set(old)
    const additions = models.filter((m) => !existing.has(m))
    if (additions.length === 0) return

    settingsStore.scopedModels.value = [...old, ...additions]
    try {
      const result = await config.setScopedModels(settingsStore.scopedModels.value)
      settingsStore.scopedModels.value = result
    } catch {
      settingsStore.scopedModels.value = old
    }
  }

  /** 从 scoped 列表移除单个模型。 */
  async function removeScopedModel(scoped: string): Promise<void> {
    const old = [...settingsStore.scopedModels.value]
    settingsStore.scopedModels.value = old.filter((s) => s !== scoped)
    try {
      const result = await config.setScopedModels(settingsStore.scopedModels.value)
      settingsStore.scopedModels.value = result
    } catch {
      settingsStore.scopedModels.value = old
    }
  }

  /** 上移/下移 scoped 模型。 */
  async function moveScopedModel(scoped: string, dir: 'up' | 'down'): Promise<void> {
    const old = [...settingsStore.scopedModels.value]
    const idx = old.indexOf(scoped)
    if (idx === -1) return
    const targetIdx = dir === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= old.length) return

    const next = [...old]
    ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
    settingsStore.scopedModels.value = next
    try {
      const result = await config.setScopedModels(settingsStore.scopedModels.value)
      settingsStore.scopedModels.value = result
    } catch {
      settingsStore.scopedModels.value = old
    }
  }

  return {
    scopedRenderItems,
    selectableModels,
    addScopedModels,
    removeScopedModel,
    moveScopedModel,
  }
}
