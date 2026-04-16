import { ref } from 'vue'
import {
  listModels,
  setCurrentModel as apiSetCurrentModel,
  saveProvider as apiSaveProvider,
  deleteProvider as apiDeleteProvider,
  isTauri,
} from '../lib/tauri'
import type { ModelInfo, ProviderConfig } from '../types'

export function useModelManager() {
  const models = ref<ModelInfo[]>([])
  const currentModel = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load() {
    if (!isTauri()) return
    loading.value = true
    error.value = null
    try {
      // Rust ModelInfo 不序列化 model_ref（它是 impl 方法），前端补充计算
      const result = await listModels()
      models.value = result.map(m => ({
        ...m,
        model_ref: `${m.provider_name}/${m.model_id}`,
      }))
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function setCurrentModel(modelRef: string) {
    try {
      await apiSetCurrentModel(modelRef)
      currentModel.value = modelRef
    } catch (e) {
      error.value = String(e)
    }
  }

  async function saveProvider(config: ProviderConfig) {
    try {
      await apiSaveProvider(config)
      await load()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function deleteProviderConfig(name: string) {
    try {
      await apiDeleteProvider(name)
      await load()
    } catch (e) {
      error.value = String(e)
    }
  }

  return { models, currentModel, loading, error, load, setCurrentModel, saveProvider, deleteProviderConfig }
}
