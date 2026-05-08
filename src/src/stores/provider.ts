import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ProviderInfo, ModelInfo, SkillInfo, AgentInfo } from '@xyz-agent/shared'

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

  const enabledModels = computed(() => models.value.filter(m => m.enabled !== false))

  return {
    providers, models, skills, agents,
    setProviders, setModels, setSkills, setAgents,
    addProvider, removeProvider, updateProvider,
    enabledModels,
  }
})
