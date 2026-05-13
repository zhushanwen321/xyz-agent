import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProviderInfo, ModelInfo, SkillInfo, AgentInfo, ScannedSkillInfo, ScannedAgentInfo } from '@xyz-agent/shared'
import { send } from '../lib/ws-client'

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

  function scanSkillsAction(sources: string[]) {
    isScanningSkills.value = true
    send({ type: 'config.scanSkills', payload: { sources } })
  }

  function scanAgentsAction(sources: string[]) {
    isScanningAgents.value = true
    send({ type: 'config.scanAgents', payload: { sources } })
  }

  function setSkill(skill: SkillInfo) {
    send({ type: 'config.setSkill', payload: { skill } })
  }

  function deleteSkillAction(skillId: string) {
    send({ type: 'config.deleteSkill', payload: { skillId } })
  }

  function toggleSkill(skillId: string) {
    const s = skills.value.find(s => s.id === skillId)
    if (s) setSkill({ ...s, enabled: !s.enabled })
  }

  function importSkills(items: ScannedSkillInfo[]) {
    for (const item of items) {
      const skill: SkillInfo = {
        id: item.id,
        name: item.name,
        description: item.description,
        enabled: true,
        source: item.sourceType,
        triggers: item.triggers,
        sourcePath: item.sourcePath,
        content: item.content,
        fileSize: item.fileSize,
        tools: item.tools,
      }
      send({ type: 'config.setSkill', payload: { skill } })
    }
  }

  function setAgent(agent: AgentInfo) {
    send({ type: 'config.setAgent', payload: { agent } })
  }

  function deleteAgentAction(agentId: string) {
    send({ type: 'config.deleteAgent', payload: { agentId } })
  }

  function toggleAgent(agentId: string) {
    const a = agents.value.find(a => a.id === agentId)
    if (a) setAgent({ ...a, enabled: !a.enabled })
  }

  function importAgents(items: ScannedAgentInfo[]) {
    for (const item of items) {
      const agent: AgentInfo = {
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
      }
      send({ type: 'config.setAgent', payload: { agent } })
    }
  }

  return {
    providers, models, skills, agents,
    scannedSkills, scannedAgents,
    isScanningSkills, isScanningAgents,
    setProviders, setModels, setSkills, setAgents,
    setScannedSkills, setScannedAgents,
    addProvider, removeProvider, updateProvider,
    scanSkillsAction, scanAgentsAction,
    setSkill, deleteSkillAction, toggleSkill, importSkills,
    setAgent, deleteAgentAction, toggleAgent, importAgents,
  }
})
