import { onMounted, onUnmounted } from 'vue'
import { useProviderStore } from '../stores/provider'
import { on, off } from '../lib/event-bus'
import { send } from '../lib/ws-client'
import type { ServerMessage, ProviderInfo, ModelInfo, SkillInfo, AgentInfo, ScannedSkillInfo, ScannedAgentInfo } from '@xyz-agent/shared'

export function useProvider() {
  const store = useProviderStore()

  function onProviders(msg: ServerMessage) {
    const payload = msg.payload as { providers?: ProviderInfo[] }
    if (payload.providers) {
      store.setProviders(payload.providers)
    }
  }

  function onModels(msg: ServerMessage) {
    store.setModels((msg.payload as { models: ModelInfo[] }).models ?? [])
  }

  function onSkills(msg: ServerMessage) {
    const payload = msg.payload as { skills?: SkillInfo[] }
    if (payload.skills) store.setSkills(payload.skills)
  }

  function onAgents(msg: ServerMessage) {
    const payload = msg.payload as { agents?: AgentInfo[] }
    if (payload.agents) store.setAgents(payload.agents)
  }

  function onScannedSkills(msg: ServerMessage) {
    store.isScanningSkills = false
    const payload = msg.payload as { skills?: ScannedSkillInfo[]; success?: boolean }
    if (payload.skills) store.setScannedSkills(payload.skills)
  }

  function onScannedAgents(msg: ServerMessage) {
    store.isScanningAgents = false
    const payload = msg.payload as { agents?: ScannedAgentInfo[]; success?: boolean }
    if (payload.agents) store.setScannedAgents(payload.agents)
  }

  function onSkillUpdated(_msg: ServerMessage) {
    // server broadcasts updated skill list via config.skills
  }

  function onAgentUpdated(_msg: ServerMessage) {
    // server broadcasts updated agent list via config.agents
  }

  const handlers: Record<string, (msg: ServerMessage) => void> = {
    'config.providers': onProviders,
    'config.providerUpdated': onProviders,
    'model.list': onModels,
    'config.skills': onSkills,
    'config.agents': onAgents,
    'config.scannedSkills': onScannedSkills,
    'config.scannedAgents': onScannedAgents,
    'config.skillUpdated': onSkillUpdated,
    'config.skillDeleted': onSkills,
    'config.agentUpdated': onAgentUpdated,
    'config.agentDeleted': onAgents,
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
