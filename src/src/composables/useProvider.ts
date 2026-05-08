import { onMounted, onUnmounted } from 'vue'
import { useProviderStore } from '../stores/provider'
import { on, off } from '../lib/event-bus'
import { send } from '../lib/ws-client'
import type { ServerMessage, ProviderInfo, ModelInfo } from '@xyz-agent/shared'

export function useProvider() {
  const store = useProviderStore()

  function onProviders(msg: ServerMessage) {
    store.setProviders((msg.payload as { providers: ProviderInfo[] }).providers)
  }

  function onModels(msg: ServerMessage) {
    store.setModels((msg.payload as { models: ModelInfo[] }).models ?? [])
  }

  const handlers: Record<string, (msg: ServerMessage) => void> = {
    'config.providers': onProviders,
    'config.providerUpdated': onProviders,
    'model.list': onModels,
  }

  onMounted(() => {
    for (const [evt, fn] of Object.entries(handlers)) on(evt, fn)
  })
  onUnmounted(() => {
    for (const [evt, fn] of Object.entries(handlers)) off(evt, fn)
  })

  function loadProviders() {
    send({ type: 'config.getProviders', payload: {} })
  }

  function setProvider(providerId: string, apiKey: string, baseUrl?: string) {
    send({ type: 'config.setProvider', payload: { providerId, apiKey, baseUrl } })
  }

  function deleteProvider(providerId: string) {
    send({ type: 'config.deleteProvider', payload: { providerId } })
  }

  return { store, loadProviders, setProvider, deleteProvider }
}
