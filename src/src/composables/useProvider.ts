import { ref } from 'vue'
import { send } from '../lib/ws-client'
import type { ProviderInfo } from '@xyz-agent/shared'

export function useProvider() {
  const providers = ref<ProviderInfo[]>([])

  function loadProviders() {
    send({ type: 'config.getProviders', payload: {} })
  }

  function setProvider(providerId: string, apiKey: string, baseUrl?: string) {
    send({ type: 'config.setProvider', payload: { providerId, apiKey, baseUrl } })
  }

  function deleteProvider(providerId: string) {
    send({ type: 'config.deleteProvider', payload: { providerId } })
  }

  return { providers, loadProviders, setProvider, deleteProvider }
}
