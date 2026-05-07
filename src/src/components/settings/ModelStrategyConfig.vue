<script setup lang="ts">
 

import { computed } from 'vue'

const props = defineProps<{
  strategy: 'auto' | 'tag' | 'bind'
  allModels: Array<{ id: string; name: string; providerName: string }>
  modelTags?: { power: string; efficient: string; fast: string }
  modelBind?: string
}>()

const emit = defineEmits<{
  'update:strategy': [value: 'auto' | 'tag' | 'bind']
  'update:modelTags': [value: { power: string; efficient: string; fast: string }]
  'update:modelBind': [value: string]
}>()

const modelGroups = computed(() => {
  const groups: Record<string, Array<{ id: string; name: string }>> = {}
  for (const m of props.allModels) {
    if (!groups[m.providerName]) groups[m.providerName] = []
    groups[m.providerName].push({ id: m.id, name: m.name })
  }
  // eslint-disable-next-line taste/no-unsafe-object-entries
  return Object.entries(groups).map(([name, models]) => ({ name, models }))
})

function onStrategyChange(e: Event) {
  emit('update:strategy', (e.target as HTMLSelectElement).value as 'auto' | 'tag' | 'bind')
}

function onTagChange(tag: 'power' | 'efficient' | 'fast', e: Event) {
  const val = (e.target as HTMLSelectElement).value
  emit('update:modelTags', { ...props.modelTags!, [tag]: val })
}

function onBindChange(e: Event) {
  emit('update:modelBind', (e.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="model-config__title">模型适配</div>
  <div class="model-config">
    <div class="model-config__row">
      <span class="model-config__row-label">策略</span>
      <select
        class="model-config__select"
        :value="strategy"
        @change="onStrategyChange"
        style="max-width:200px"
      >
        <option value="auto">自动（主 Agent 判断）</option>
        <option value="tag">按标签选择</option>
        <option value="bind">绑定具体模型</option>
      </select>
    </div>
    <!-- Tag rows -->
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">强力模型</span>
      <select
        class="model-config__select"
        :value="modelTags?.power"
        @change="onTagChange('power', $event)"
      >
        <option v-for="m in allModels" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">高效模型</span>
      <select
        class="model-config__select"
        :value="modelTags?.efficient"
        @change="onTagChange('efficient', $event)"
      >
        <option v-for="m in allModels" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">快速模型</span>
      <select
        class="model-config__select"
        :value="modelTags?.fast"
        @change="onTagChange('fast', $event)"
      >
        <option v-for="m in allModels" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <!-- Bind row -->
    <div v-if="strategy === 'bind'" class="model-config__row">
      <span class="model-config__row-label">绑定模型</span>
      <select
        class="model-config__select"
        :value="modelBind"
        @change="onBindChange"
      >
        <optgroup v-for="group in modelGroups" :key="group.name" :label="group.name">
          <option v-for="m in group.models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </optgroup>
      </select>
    </div>
  </div>
</template>

<style scoped>
.model-config__title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 8px;
}

.model-config {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin-bottom: 12px;
}

.model-config__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.model-config__row:last-child {
  border-bottom: none;
}

.model-config__row-label {
  font-size: 12px;
  min-width: 60px;
  font-weight: 500;
}

.model-config__select {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 12px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s var(--ease);
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.model-config__select:focus {
  border-color: var(--accent);
}
</style>
