import { onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { useProviderStore } from '../stores/provider'
import { on, off } from '../lib/event-bus'
import { send } from '../lib/ws-client'
import type { ServerMessage, ProviderInfo, ModelInfo, SkillInfo, AgentInfo, ScannedSkillInfo, ScannedAgentInfo } from '@xyz-agent/shared'

// ── 全局事件处理器（ref-counted，解决多组件重复注册问题）───

let globalListenerRefCount = 0
let globalEventMap: Record<string, (msg: ServerMessage) => void> | null = null

function registerGlobalListeners(handlers: Record<string, (msg: ServerMessage) => void>) {
  if (globalEventMap) return
  globalEventMap = handlers
  for (const [evt, fn] of Object.entries(handlers)) on(evt, fn)
}

function unregisterGlobalListeners() {
  if (!globalEventMap) return
  for (const [evt, fn] of Object.entries(globalEventMap)) off(evt, fn)
  globalEventMap = null
}

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

  function onSkillUpdated() {
    // server broadcasts updated skill list via config.skills
  }

  function onAgentUpdated() {
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

  // 全局事件 listener 生命周期：第一个组件 mounted 时注册，最后一个 unmounted 时注销
  if (getCurrentInstance()) {
    onMounted(() => {
      if (globalListenerRefCount === 0) {
        registerGlobalListeners(handlers)
      }
      globalListenerRefCount++
    })

    onUnmounted(() => {
      globalListenerRefCount--
      if (globalListenerRefCount === 0) {
        unregisterGlobalListeners()
      }
    })
  }

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
