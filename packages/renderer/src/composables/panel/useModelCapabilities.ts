/**
 * 模型能力查询（vision 等）。
 *
 * ModelInfo 类型（shared/provider.ts:30-42）不含 input 字段——runtime toModelInfo
 * 不拷贝 input（model-mapper.ts:43 注释明确），故 vision 能力只能从 ProviderInfo.models 元素
 * 的 input?: Array<'text'|'image'> 取。解析范式照搬 useThinkingLevelSync.ts:30-38
 *（同一 settingsStore.providers 按 currentModelId split providerId/modelId 查找路径）。
 *
 * 双形态：
 * - resolveSupportsVision(modelId, providers)：纯同步函数，send 等瞬时动作取当下快照用。
 * - useModelCapabilities(currentModelId)：composable 返 ComputedRef，供 Vue 组件
 *   （如未来 ModelSelectPopover 标注 vision 支持）响应式消费。composable 内部委托
 *   resolveSupportsVision，单一真相源。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/** ProviderInfo.models 元素的最小能力字段集（够解析 input，避免耦合完整类型）。 */
interface ModelWithInput {
  id: string
  input?: Array<'text' | 'image'>
}
interface ProviderWithModels {
  id: string
  models: ModelWithInput[]
}

/**
 * 解析 modelId 是否支持 vision（image 输入）。
 *
 * modelId 格式 'providerId/modelId'（与 useThinkingLevelSync 同 split 约定）：
 * - 无 '/'（格式异常）/ provider 找不到 / model 找不到 / input 不含 image → false（保守降级）。
 * - 找到且 input 含 'image' → true。
 *
 * 保守降级为 false 的最坏后果是多发一次 vision 降级 console.warn，images 仍正常投递
 * （不剥离），功能不受损。
 */
export function resolveSupportsVision(
  modelId: string,
  providers: ProviderWithModels[],
): boolean {
  const sep = modelId.lastIndexOf('/')
  if (sep < 0) return false
  const providerId = modelId.slice(0, sep)
  const modelSubId = modelId.slice(sep + 1)
  const provider = providers.find((p) => p.id === providerId)
  return Boolean(provider?.models.find((m) => m.id === modelSubId)?.input?.includes('image'))
}

/**
 * 当前模型能力 composable（响应式）。
 *
 * @param currentModelId 当前模型 id（ComputedRef 或 Ref，格式 'providerId/modelId'）
 * @returns { supportsVision } 响应式 vision 支持标志
 */
export function useModelCapabilities(currentModelId: ComputedRef<string> | Ref<string>): {
  supportsVision: ComputedRef<boolean>
} {
  const settingsStore = useSettingsStore()
  const supportsVision = computed(() =>
    resolveSupportsVision(currentModelId.value, settingsStore.providers),
  )
  return { supportsVision }
}
