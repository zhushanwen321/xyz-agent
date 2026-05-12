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
    <div class="mb-7">
      <div class="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted mb-3">已配置的 Agent</div>
      <div v-for="agent in agents" :key="agent.name" class="flex items-center gap-3 py-3 px-3.5 bg-surface border border-border rounded-sm mb-2">
        <span class="font-semibold text-sm flex-1">{{ agent.name }}</span>
        <span class="text-[11px] text-muted font-mono">{{ agent.model }}</span>
        <span :class="['text-[11px] font-semibold px-2 py-[1px] rounded-full', agent.active ? 'bg-success-light text-success' : 'bg-bg text-muted']">
          {{ agent.active ? '活跃' : '闲置' }}
        </span>
      </div>
    </div>
    <div class="mb-7">
      <div class="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted mb-3">Agent 默认配置</div>
      <div v-for="row in configRows" :key="row.label" class="flex justify-between items-center py-1.5 text-[13px] border-b border-border last:border-b-0">
        <span class="text-muted">{{ row.label }}</span>
        <span class="font-mono text-xs">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>
