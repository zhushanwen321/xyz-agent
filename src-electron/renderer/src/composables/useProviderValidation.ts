import { ref, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ServerMessage } from '@xyz-agent/shared'
import { api } from '../api'
import { useProvider } from './useProvider'

const DISCOVER_TIMEOUT_MS = 15_000

/**
 * Composable for provider validation via model discovery.
 * Extracted from ProviderModal.vue to reduce component size and centralize
 * listener lifecycle management.
 *
 * Usage:
 *   const { discoverStatus, discoverMessage, discover, validateAndSave } = useProviderValidation()
 *   discover(baseUrl, key, type, providerId?)  // fire-and-forget discover
 *   validateAndSave(baseUrl, key, type, providerId?, onValid)  // validate then save
 */
export function useProviderValidation() {
  const { t } = useI18n()
  const { discoverModels } = useProvider()

  const discoverStatus = ref<'idle' | 'loading' | 'error' | 'empty' | 'success'>('idle')
  const discoverMessage = ref('')
  const isSaving = ref(false)

  // 取消函数（api.events.on 返回），cleanup 时调用
  let discoverOff: (() => void) | null = null
  let saveOff: (() => void) | null = null
  let discoverTimer: ReturnType<typeof setTimeout> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function cleanup() {
    if (discoverOff) {
      discoverOff()
      discoverOff = null
    }
    if (saveOff) {
      saveOff()
      saveOff = null
    }
    if (discoverTimer) {
      clearTimeout(discoverTimer)
      discoverTimer = null
    }
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  onUnmounted(cleanup)

  /** Fire-and-forget auto-discover (used by Discover button) */
  function discover(
    baseUrl: string,
    key: string | undefined,
    type: string,
    providerId: string | undefined,
    onSuccess?: (models: Array<{ id: string; name?: string; contextWindow?: number }>) => void,
  ) {
    discoverStatus.value = 'loading'
    cleanup()

    discoverTimer = setTimeout(() => {
      cleanup()
      discoverStatus.value = 'error'
      discoverMessage.value = t('settings.discoveryTimeoutHint')
    }, DISCOVER_TIMEOUT_MS)

    const discoverHandler = (msg: unknown) => {
      cleanup()
      const payload = (msg as { payload: Record<string, unknown> }).payload
      const success = payload.success as boolean
      if (success) {
        const models = payload.models as Array<{ id: string; name?: string; contextWindow?: number }> | undefined
        if (models && models.length > 0) {
          discoverStatus.value = 'success'
          discoverMessage.value = t('settings.foundModels', { n: models.length })
          onSuccess?.(models)
        } else {
          discoverStatus.value = 'empty'
          discoverMessage.value = t('settings.noModelsFoundHint')
        }
      } else {
        discoverStatus.value = 'error'
        discoverMessage.value = (payload.error as string) || t('settings.discoveryFailedHint')
      }
    }
    discoverOff = api.events.on('config.discoveredModels', discoverHandler as (m: ServerMessage) => void)

    discoverModels(baseUrl, key, type, providerId)
  }

  /**
   * Validate provider connectivity via model discovery, then call onValid on success.
   * Used by Save button to verify before persisting.
   */
  function validateAndSave(
    baseUrl: string,
    key: string | undefined,
    type: string,
    providerId: string | undefined,
    onValid: () => void,
  ) {
    isSaving.value = true
    discoverStatus.value = 'loading'
    discoverMessage.value = ''
    cleanup()

    saveTimer = setTimeout(() => {
      cleanup()
      isSaving.value = false
      discoverStatus.value = 'error'
      discoverMessage.value = t('settings.discoveryTimeoutHint')
    }, DISCOVER_TIMEOUT_MS)

    const saveHandler = (msg: unknown) => {
      cleanup()
      const payload = (msg as { payload: Record<string, unknown> }).payload
      const success = payload.success as boolean
      if (success) {
        // Validation passed — do NOT merge discovered models here.
        // The save path uses discover only to verify connectivity;
        // merging would undo user's manual deletions.
        onValid()
      } else {
        discoverStatus.value = 'error'
        discoverMessage.value = (payload.error as string) || t('settings.discoveryFailedHint')
      }
      isSaving.value = false
    }
    saveOff = api.events.on('config.discoveredModels', saveHandler as (m: ServerMessage) => void)

    discoverModels(baseUrl, key, type, providerId)
  }

  return {
    discoverStatus,
    discoverMessage,
    isSaving,
    discover,
    validateAndSave,
    cleanup,
  }
}
