<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { useProviderStore } from '../../stores/provider'
import type { ScannedAgentInfo, AgentInfo } from '@xyz-agent/shared'
import ScanImportSection from './ScanImportSection.vue'
import AgentSection from './AgentSection.vue'
import AgentModal from './AgentModal.vue'

const providerStore = useProviderStore()
const agents = computed(() => providerStore.agents)
const showModal = ref(false)

const scanSources = [
  { id: 'pi', icon: 'P', label: 'Pi Agents', path: '~/.pi/agent/agents/', defaultActive: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/agents/', defaultActive: false },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/agents/', defaultActive: false },
]

const allModels = computed(() =>
  providerStore.enabledModels.map(m => ({ id: m.id, name: m.name, providerName: m.providerName })),
)

function handleScan(sources: string[]) {
  providerStore.scanAgentsAction(sources)
}

function handleImport(items: ScannedAgentInfo[]) {
  providerStore.importAgents(items)
}

function handleUpdateStrategy(payload: { agentId: string; strategy: string }) {
  const agent = agents.value.find(a => a.id === payload.agentId)
  if (agent) {
    providerStore.setAgent({ ...agent, modelStrategy: payload.strategy })
  }
}

function handleAgentSave(data: { name: string; description: string; modelStrategy: string; modelBind?: string }) {
  const newAgent: AgentInfo = {
    id: `agent-${Date.now()}`,
    name: data.name,
    description: data.description,
    enabled: true,
    modelStrategy: data.modelStrategy,
    modelBind: data.modelBind,
  }
  providerStore.setAgent(newAgent)
  showModal.value = false
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">Agent 配置</div>
        <div class="text-[12px] text-muted mt-1">扫描、导入和管理 AI Agent 模块</div>
      </div>
      <Button variant="primary" @click="showModal = true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        手动添加
      </Button>
    </div>

    <ScanImportSection
      :sources="scanSources"
      scan-event-type="config.scanAgents"
      scanned-event-type="config.scannedAgents"
      :existing-items="agents.map(a => ({ id: a.id, name: a.name }))"
      :is-scanning="providerStore.isScanningAgents"
      :scanned-results="providerStore.scannedAgents"
      @scan="handleScan"
      @import="handleImport"
    />

    <!-- Agent sections -->
    <div v-if="agents.length > 0" class="border border-border rounded-lg overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">已导入</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ agents.length }}</span>
      </div>
      <div>
        <AgentSection
          v-for="agent in agents"
          :key="agent.id"
          :agent="agent"
          :all-models="allModels"
          @toggle-enabled="providerStore.toggleAgent(agent.id)"
          @update-strategy="handleUpdateStrategy"
          @delete="providerStore.deleteAgentAction(agent.id)"
        />
      </div>
    </div>

    <AgentModal :visible="showModal" :models="allModels" @close="showModal = false" @save="handleAgentSave" />
  </div>
</template>
