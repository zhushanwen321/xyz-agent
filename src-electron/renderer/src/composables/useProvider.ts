import { onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { useProviderStore } from '../stores/provider'
import { useSettingsStore } from '../stores/settings'
import { api } from '../api'
import type { ServerMessage, ServerMessageType, ProviderInfo, ModelInfo, SkillInfo, AgentInfo, ScannedSkillInfo, ScannedAgentInfo, SetProviderData } from '@xyz-agent/shared'

// ── 全局事件处理器（ref-counted，解决多组件重复注册问题）───

let globalListenerRefCount = 0
let globalEventMap: Map<ServerMessageType, (msg: ServerMessage) => void> | null = null
let globalOffs: Array<() => void> = []

function registerGlobalListeners(handlers: Map<ServerMessageType, (msg: ServerMessage) => void>) {
  if (globalEventMap) return
  globalEventMap = handlers
  globalOffs = []
  for (const [evt, fn] of handlers) globalOffs.push(api.events.on(evt, fn))
}

function unregisterGlobalListeners() {
  if (!globalEventMap) return
  for (const off of globalOffs) off()
  globalOffs = []
  globalEventMap = null
}

export function useProvider() {
  const store = useProviderStore()
  const settingsStore = useSettingsStore()

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

  function onDefaults(msg: ServerMessage) {
    const payload = msg.payload as { defaultModel?: string; source?: string }
    // 服务端为准：model.switch 持久化并广播新默认模型，所有 panel 必须同步。
    // sendInitialState 也会发送 config.defaults（无 source），这是初始状态同步。
    // source='model-switch' 来自用户主动切换，无条件覆盖。
    // 无 source 的广播来自 sendInitialState（连接时的状态同步），同样无条件接受。
    // 两者都是合法的服务端真相来源，不需要旧逻辑 “仅 unset 时写入” 的保护。
    if (payload.defaultModel) {
      settingsStore.defaultModel = payload.defaultModel
    }
  }

  const handlers = new Map<ServerMessageType, (msg: ServerMessage) => void>([
    ['config.providers', onProviders],
    ['config.providerUpdated', onProviders],
    ['model.list', onModels],
    ['config.defaults', onDefaults],
    ['config.skills', onSkills],
    ['config.agents', onAgents],
    ['config.scannedSkills', onScannedSkills],
    ['config.scannedAgents', onScannedAgents],
    ['config.skillUpdated', onSkillUpdated],
    ['config.skillDeleted', onSkills],
    ['config.agentUpdated', onAgentUpdated],
    ['config.agentDeleted', onAgents],
  ])

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
    api.config.getProviders()
  }

  function setProvider(providerId: string, data: SetProviderData = {}) {
    api.config.setProvider({ providerId, ...data })
  }

  function deleteProvider(providerId: string) {
    api.config.deleteProvider({ providerId })
  }

  function discoverModels(baseUrl: string, apiKey?: string, providerType?: string, providerId?: string) {
    api.config.discoverModels({ baseUrl, ...(apiKey && { apiKey }), ...(providerType && { providerType }), ...(providerId && { providerId }) })
  }

  function scanSkills(sources: string[]) {
    store.isScanningSkills = true
    api.config.scanSkills({ sources })
  }

  function setSkill(skill: SkillInfo) {
    api.config.setSkill({ skill })
  }

  function deleteSkill(skillId: string) {
    api.config.deleteSkill({ skillId })
  }

  function scanAgents(sources: string[]) {
    store.isScanningAgents = true
    api.config.scanAgents({ sources })
  }

  function setAgent(agent: AgentInfo) {
    api.config.setAgent({ agent })
  }

  function deleteAgent(agentId: string) {
    api.config.deleteAgent({ agentId })
  }

  function toggleSkill(skillId: string) {
    const s = store.skills.find(s => s.id === skillId)
    if (s) setSkill({ ...s, enabled: !s.enabled })
  }

  function toggleAgent(agentId: string) {
    const a = store.agents.find(a => a.id === agentId)
    if (a) setAgent({ ...a, enabled: !a.enabled })
  }

  function importSkills(items: ScannedSkillInfo[]) {
    for (const item of items) {
      setSkill({
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: true,
        source: item.sourceType,
        triggers: item.triggers,
        argumentHint: item.argumentHint,
        sourcePath: item.sourcePath,
        content: item.content,
        fileSize: item.fileSize,
        tools: item.tools,
      })
    }
  }

  function importAgents(items: ScannedAgentInfo[]) {
    for (const item of items) {
      setAgent({
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: true,
        modelStrategy: 'auto',
        icon: item.icon,
        source: item.sourceType,
        sourceType: item.sourceType,
        content: item.content,
        tools: item.tools,
      })
    }
  }

  return {
    store, loadProviders, setProvider, deleteProvider,
    discoverModels,
    scanSkills, setSkill, deleteSkill, toggleSkill, importSkills,
    scanAgents, setAgent, deleteAgent, toggleAgent, importAgents,
  }
}
