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
      models.value = await listModels()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function setCurrentModel(modelRef: string) {
    await apiSetCurrentModel(modelRef)
    currentModel.value = modelRef
  }

  async function saveProvider(config: ProviderConfig) {
    await apiSaveProvider(config)
    await load()
  }

  async function deleteProviderConfig(name: string) {
    await apiDeleteProvider(name)
    await load()
  }

  return { models, currentModel, loading, error, load, setCurrentModel, saveProvider, deleteProviderConfig }
}
