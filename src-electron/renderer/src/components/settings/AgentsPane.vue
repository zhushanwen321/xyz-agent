<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { useProviderStore } from '../../stores/provider'
import { useProvider } from '../../composables/useProvider'
import type { ScannedAgentInfo, AgentInfo } from '@xyz-agent/shared'
import ScanImportSection from './ScanImportSection.vue'
import AgentSection from './AgentSection.vue'
import AgentModal from './AgentModal.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const providerStore = useProviderStore()
const { scanAgents, setAgent, deleteAgent, toggleAgent, importAgents } = useProvider()
const agents = computed(() => providerStore.agents)
const showModal = ref(false)
const editingAgent = ref<AgentInfo | null>(null)

const scanSources = [
  { id: 'pi', icon: 'P', label: 'Pi Agents', path: '~/.pi/agent/agents/', defaultActive: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/agents/', defaultActive: false },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/agents/', defaultActive: false },
]

function handleScan(sources: string[]) {
  scanAgents(sources)
}

function handleImport(items: ScannedAgentInfo[]) {
  importAgents(items)
}

function handleAgentSave(data: { name: string; description: string; content: string }) {
  if (editingAgent.value) {
    setAgent({
      ...editingAgent.value,
      name: data.name,
      description: data.description,
      content: data.content,
    })
  } else {
    const newAgent: AgentInfo = {
      id: `agent-${Date.now()}`,
      name: data.name,
      description: data.description,
      enabled: true,
      modelStrategy: 'auto',
      content: data.content,
    }
    setAgent(newAgent)
  }
  showModal.value = false
  editingAgent.value = null
}

function openEditModal(agent: AgentInfo) {
  editingAgent.value = agent
  showModal.value = true
}

function openAddModal() {
  editingAgent.value = null
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingAgent.value = null
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">{{ t('settings.agentConfig') }}</div>
        <div class="text-[12px] text-muted mt-1">{{ t('settings.agentConfigDesc') }}</div>
      </div>
      <Button variant="primary" @click="openAddModal">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        {{ t('settings.manualAdd') }}
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
    <div v-if="agents.length > 0" class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.imported') }}</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ agents.length }}</span>
      </div>
      <div>
        <AgentSection
          v-for="agent in agents"
          :key="agent.id"
          :agent="agent"
          @toggle-enabled="toggleAgent(agent.id)"
          @edit="openEditModal(agent)"
          @delete="deleteAgent(agent.id)"
        />
      </div>
    </div>

    <AgentModal :visible="showModal" :agent="editingAgent" @close="closeModal" @save="handleAgentSave" />
  </div>
</template>
