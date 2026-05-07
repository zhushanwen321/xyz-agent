<script setup lang="ts">
import { ref, computed } from 'vue'
import { mockAgents, mockModels, mockGlobalParams } from '../../mock/data'
import GlobalParams from './GlobalParams.vue'
import AgentCard from './AgentCard.vue'

const agents = ref([...mockAgents])
const globalParams = ref({ ...mockGlobalParams })
const expandedId = ref<string | null>(null)
const scanPath = ref('')

const allModels = computed(() =>
  mockModels.map(m => ({ id: m.id, name: m.name, providerName: m.providerName })),
)
</script>

<template>
  <div class="agents-pane">
    <div class="page__hd">
      <div class="page__title">Agent 配置</div>
    </div>

    <!-- Scan section (like SkillImportSection) -->
    <div class="scan-section">
      <div class="scan-section__title">扫描 Agent</div>
      <div class="scan-paths">
        <div class="scan-path active">
          <span class="scan-path__icon scan-path__icon--pi">P</span>
          <span>
            <span class="scan-path__label">Pi Agents</span><br>
            <span class="scan-path__path">~/.pi/agent/agents/</span>
          </span>
        </div>
        <div class="scan-path">
          <span class="scan-path__icon scan-path__icon--agents">A</span>
          <span>
            <span class="scan-path__label">Agents</span><br>
            <span class="scan-path__path">~/.agents/agents/</span>
          </span>
        </div>
      </div>
      <div class="scan-custom">
        <input class="scan-custom__input" v-model="scanPath" placeholder="自定义路径，如 ~/my-project/.agents/">
        <button class="btn btn--sm">扫描</button>
      </div>
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

/* Scan section */
.scan-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 24px;
}
.scan-section__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.scan-paths {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.scan-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  font-size: 13px;
  user-select: none;
}
.scan-path:hover {
  border-color: var(--accent);
  background: var(--accent-light);
}
.scan-path.active {
  border-color: var(--accent);
  background: var(--accent-light);
  color: var(--accent);
}
.scan-path__icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}
.scan-path__icon--pi { background: var(--accent); }
.scan-path__icon--agents { background: var(--success); }
.scan-path__label { font-weight: 500; }
.scan-path__path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.scan-custom {
  display: flex;
  gap: 8px;
  align-items: center;
}
.scan-custom__input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}
.scan-custom__input:focus { border-color: var(--accent); }
.scan-custom__input::placeholder { color: var(--muted); }

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
.btn--sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: var(--radius-xs);
}
</style>
