import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProviderInfo, ModelInfo, SkillInfo, AgentInfo, ScannedSkillInfo, ScannedAgentInfo } from '@xyz-agent/shared'

/**
 * Provider store — 纯状态容器。
 * 所有 send() 调用已上移到 useProvider composable。
 * Store 只负责状态读写，不直接与 WebSocket 通信。
 */
export const useProviderStore = defineStore('provider', () => {
  const providers = ref<ProviderInfo[]>([])
  const models = ref<ModelInfo[]>([])
  const skills = ref<SkillInfo[]>([])
  const agents = ref<AgentInfo[]>([])

  function setProviders(list: ProviderInfo[]) { providers.value = list }
  function setModels(list: ModelInfo[]) { models.value = list }
  function setSkills(list: SkillInfo[]) { skills.value = list }
  function setAgents(list: AgentInfo[]) { agents.value = list }

  function addProvider(p: ProviderInfo) { providers.value = [...providers.value, p] }
  function removeProvider(id: string) { providers.value = providers.value.filter(p => p.id !== id) }
  function updateProvider(id: string, data: Partial<ProviderInfo>) {
    providers.value = providers.value.map(p => p.id === id ? { ...p, ...data } : p)
  }

  const scannedSkills = ref<ScannedSkillInfo[]>([])
  const scannedAgents = ref<ScannedAgentInfo[]>([])
  const isScanningSkills = ref(false)
  const isScanningAgents = ref(false)

  function setScannedSkills(list: ScannedSkillInfo[]) { scannedSkills.value = list }
  function setScannedAgents(list: ScannedAgentInfo[]) { scannedAgents.value = list }

  return {
    providers, models, skills, agents,
    scannedSkills, scannedAgents,
    isScanningSkills, isScanningAgents,
    setProviders, setModels, setSkills, setAgents,
    setScannedSkills, setScannedAgents,
    addProvider, removeProvider, updateProvider,
  }
})
