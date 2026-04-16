import { ref } from 'vue'
import { getConfig, updateConfig, checkApiKey, isTauri } from '../lib/tauri'
import type { ConfigResponse, UpdateConfigRequest } from '../types'

export function useSettings() {
  const config = ref<ConfigResponse | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const success = ref(false)
  const apiKeyConfigured = ref<boolean | null>(null)

  async function load() {
    if (!isTauri()) return
    loading.value = true
    error.value = null
    try {
      config.value = await getConfig()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function save() {
    if (!config.value) return
    saving.value = true
    error.value = null
    success.value = false
    try {
      const payload: UpdateConfigRequest = {
        max_turns: config.value.max_turns,
        context_window: config.value.context_window,
        max_output_tokens: config.value.max_output_tokens,
        tool_output_max_bytes: config.value.tool_output_max_bytes,
        bash_default_timeout_secs: config.value.bash_default_timeout_secs,
        thinking_enabled: config.value.thinking_enabled,
        thinking_budget_tokens: config.value.thinking_budget_tokens,
      }
      await updateConfig(payload)
      success.value = true
      setTimeout(() => { success.value = false }, 3000)
    } catch (e) {
      error.value = String(e)
    } finally {
      saving.value = false
    }
  }

  async function checkKey(): Promise<boolean> {
    if (!isTauri()) return false
    try {
      const result = await checkApiKey()
      apiKeyConfigured.value = result
      return result
    } catch {
      apiKeyConfigured.value = false
      return false
    }
  }

  return { config, loading, saving, error, success, apiKeyConfigured, load, save, checkKey }
}
