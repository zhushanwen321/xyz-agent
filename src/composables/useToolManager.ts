import { ref } from 'vue'
import { toolConfigList, toolConfigSave, toolConfigDelete, isTauri } from '../lib/tauri'
import type { ToolInfo, ToolConfigSaveInput } from '../types'

export function useToolManager() {
  const tools = ref<ToolInfo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load() {
    if (!isTauri()) return
    loading.value = true
    error.value = null
    try {
      tools.value = await toolConfigList()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function save(input: ToolConfigSaveInput): Promise<void> {
    await toolConfigSave(input)
    await load()
  }

  async function reset(name: string): Promise<void> {
    await toolConfigDelete(name)
    await load()
  }

  return { tools, loading, error, load, save, reset }
}
