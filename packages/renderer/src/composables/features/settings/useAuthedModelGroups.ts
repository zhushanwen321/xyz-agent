/**
 * useAuthedModelGroups —— 设置页「按 provider 分组的可选模型」共享 composable。
 *
 * 消费方：SystemAutoRenameSection（renameModel）/ SystemSmartContextSection（compactModel），
 * 两处此前各自维护逐字同构的 modelGroups/availableValues/sentinel 逻辑。
 *
 * 数据源：settings store（runtime aggregateModels 常驻订阅，与 ModelSelectPopover 同源）；
 * 只列已配凭证 provider 的模型——extension 的 resolveModel 对无凭证模型
 * hasConfiguredAuth 不通过，选了也不工作，不如不列。凭证过滤用 providers 的 apiKeySet。
 */
import { computed } from 'vue'
import { getSettingsStore } from '@xyz-agent/core'

export interface AuthedModelOption {
  value: string
  label: string
}
export interface AuthedModelGroup {
  providerId: string
  providerName: string
  models: AuthedModelOption[]
}

export function useAuthedModelGroups() {
  const settingsStore = getSettingsStore()

  const modelGroups = computed<AuthedModelGroup[]>(() => {
    const authedProviderIds = new Set(settingsStore.providers.value.filter((p) => p.apiKeySet).map((p) => p.id))
    const groups: AuthedModelGroup[] = []
    const byProviderId = new Map<string, AuthedModelGroup>()
    for (const m of settingsStore.models.value) {
      if (!authedProviderIds.has(m.providerId)) continue
      let group = byProviderId.get(m.providerId)
      if (!group) {
        group = { providerId: m.providerId, providerName: m.providerName, models: [] }
        byProviderId.set(m.providerId, group)
        groups.push(group)
      }
      group.models.push({ value: `${m.providerId}/${m.id}`, label: m.name || m.id })
    }
    return groups
  })

  /** 可选模型值集合（判断当前 ref 是否 stale）。 */
  const availableValues = computed(() => new Set(modelGroups.value.flatMap((g) => g.models.map((m) => m.value))))

  return { modelGroups, availableValues }
}

/**
 * 「未设置」项 sentinel value。reka-ui 禁止 SelectItem value=""（空串是 Select
 * 清空选择的保留值），与 SystemPage 提示音 SOUND_DEFAULT='__default__' 同款处理：
 * change 时映射回空串持久化（空串 = extension 的 model.ref 默认值）。
 * 不会与真实模型 ref 冲突（ref 必含 '/'，'__unset__' 不含）。
 */
export const MODEL_UNSET_SENTINEL = '__unset__'

/** Select 受控值：空串 → sentinel；否则原样 ref（不在列表时由 staleRef 项兜底显示）。 */
export function toSelectValue(model: string): string {
  return model === '' ? MODEL_UNSET_SENTINEL : model
}

/** Select change 值 → 持久化值：非 sentinel 字符串原样，其余（sentinel / 非字符串）→ 空串。 */
export function fromSelectValue(value: unknown): string {
  return typeof value === 'string' && value !== MODEL_UNSET_SENTINEL ? value : ''
}

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
export function staleModelRef(model: string, availableValues: ReadonlySet<string>): string | null {
  return model !== '' && !availableValues.has(model) ? model : null
}
