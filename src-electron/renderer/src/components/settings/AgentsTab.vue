<script setup lang="ts">
interface Agent {
  name: string
  model: string
  active: boolean
}

interface ConfigRow {
  label: string
  value: string
}

defineProps<{
  agents: Agent[]
  configRows: ConfigRow[]
}>()
</script>

<template>
  <div>
    <div class="settings-section">
      <div class="settings-section__title">已配置的 Agent</div>
      <div v-for="agent in agents" :key="agent.name" class="agent-card">
        <span class="agent-card__name">{{ agent.name }}</span>
        <span class="agent-card__model">{{ agent.model }}</span>
        <span :class="['provider-card__status', agent.active ? 'provider-card__status--on' : 'provider-card__status--off']">
          {{ agent.active ? '活跃' : '闲置' }}
        </span>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section__title">Agent 默认配置</div>
      <div v-for="row in configRows" :key="row.label" class="info-row">
        <span class="info-row__label">{{ row.label }}</span>
        <span class="info-row__value">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>
