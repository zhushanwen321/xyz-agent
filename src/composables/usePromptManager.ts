import { ref } from 'vue'
import {
  promptList,
  promptGet,
  promptPreview,
  promptSave,
  promptDelete,
  customAgentSave,
  customAgentDelete,
  isTauri,
} from '../lib/tauri'
import type { PromptInfo, PromptSaveInput, CustomAgentInput } from '../types'

export function usePromptManager() {
  const prompts = ref<PromptInfo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load() {
    if (!isTauri()) return
    loading.value = true
    error.value = null
    try {
      prompts.value = await promptList()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function get(key: string): Promise<string> {
    return promptGet(key)
  }

  async function preview(key: string): Promise<string> {
    return promptPreview(key)
  }

  async function save(input: PromptSaveInput): Promise<void> {
    await promptSave(input)
    await load()
  }

  async function remove(key: string): Promise<void> {
    await promptDelete(key)
    await load()
  }

  async function saveAgent(input: CustomAgentInput): Promise<void> {
    await customAgentSave(input)
    await load()
  }

  async function deleteAgent(name: string): Promise<void> {
    await customAgentDelete(name)
    await load()
  }

  return {
    prompts,
    loading,
    error,
    load,
    get,
    preview,
    save,
    remove,
    saveAgent,
    deleteAgent,
  }
}
