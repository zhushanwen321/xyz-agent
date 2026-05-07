<script setup lang="ts">
 

import { ref, computed } from 'vue'
import { mockAgents, mockModels, mockGlobalParams } from '../../mock/data'
import GlobalParams from './GlobalParams.vue'
import AgentCard from './AgentCard.vue'

// ─── State ──────────────────────────────────────────────────────

const agents = ref([...mockAgents])
const globalParams = ref({ ...mockGlobalParams })
const expandedId = ref<string | null>(null)

// ─── Computed ───────────────────────────────────────────────────

const allModels = computed(() =>
  mockModels.map(m => ({ id: m.id, name: m.name, providerName: m.providerName })),
)
</script>

<template>
  <div class="agents-pane">
    <div class="page__hd">
      <div class="page__title">Agent 配置</div>
      <button class="btn btn--primary">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        导入 Agent
      </button>
    </div>

    <GlobalParams v-model="globalParams" />

    <div class="section-divider">已导入 · {{ agents.length }} 个 Agent</div>

    <AgentCard
      v-for="agent in agents"
      :key="agent.name"
      :agent="agent"
      :all-models="allModels"
      :expanded="expandedId === agent.name"
      @toggle="expandedId = expandedId === agent.name ? null : agent.name"
      @toggle-enabled="agent.active = !agent.active"
    />
  </div>
</template>

<style scoped>
.agents-pane {
  max-width: 860px;
  padding: 32px 40px;
}

.page__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}

.page__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.section-divider {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 20px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}

.btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn--primary:hover {
  opacity: 0.88;
}
</style>
