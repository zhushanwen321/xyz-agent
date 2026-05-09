<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { useProviderStore } from '../../stores/provider'
import type { AgentInfo } from '@xyz-agent/shared'
import GlobalParams from './GlobalParams.vue'
import ImportSection, { type ImportSource } from './shared/ImportSection.vue'
import AgentCard from './AgentCard.vue'
import AgentModal from './AgentModal.vue'

const providerStore = useProviderStore()
const agents = computed(() => providerStore.agents)
const globalParams = ref({ depth: 20, width: 10, tokens: 100_000, rounds: 50 })
const expandedId = ref<string | null>(null)
const showModal = ref(false)

const scanSources: ImportSource[] = [
  { id: 'pi', icon: 'P', label: 'Pi Agents', path: '~/.pi/agent/agents/', active: true },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/agents/', active: false },
]

const allModels = computed(() =>
  providerStore.enabledModels.map(m => ({ id: m.id, name: m.name, providerName: m.providerName })),
)

function handleAgentSave(data: { name: string; description: string; modelStrategy: string; modelBind?: string }) {
  const newAgent: AgentInfo = {
    id: `agent-${Date.now()}`,
    name: data.name,
    description: data.description,
    enabled: true,
    modelStrategy: data.modelStrategy,
    modelBind: data.modelBind,
  }
  providerStore.setAgents([...providerStore.agents, newAgent])
  showModal.value = false
}
</script>

<template>
  <div class="s-page">
    <div class="s-page__hd">
      <div class="s-page__title">Agent 配置</div>
      <Button variant="primary" @click="showModal = true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        导入 Agent
      </Button>
    </div>

    <ImportSection
      title="扫描 Agent"
      :sources="scanSources"
      custom-placeholder="自定义路径，如 ~/my-project/.agents/"
    />

    <GlobalParams v-model="globalParams" />

    <div class="s-divider">已导入 · {{ agents.length }} 个 Agent</div>

    <AgentCard
      v-for="agent in agents"
      :key="agent.name"
      :agent="agent"
      :all-models="allModels"
      :expanded="expandedId === agent.name"
      @toggle="expandedId = expandedId === agent.name ? null : agent.name"
      @toggle-enabled="providerStore.setAgents(agents.map(a => a.id === agent.id ? { ...a, enabled: !a.enabled } : a))"
    />

    <AgentModal :visible="showModal" :models="allModels" @close="showModal = false" @save="handleAgentSave" />
  </div>
</template>


