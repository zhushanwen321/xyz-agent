<script setup lang="ts">
import { computed } from 'vue'
import { Select } from '../../design-system'

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

const strategyOptions = computed(() => [
  { label: '自动（主 Agent 判断）', value: 'auto' },
  { label: '按标签选择', value: 'tag' },
  { label: '绑定具体模型', value: 'bind' },
])

const allModelOptions = computed(() =>
  props.allModels.map(m => ({ label: m.name, value: m.id })),
)

const bindModelOptions = computed(() => {
  const groups: Record<string, Array<{ id: string; name: string }>> = {}
  for (const m of props.allModels) {
    if (!groups[m.providerName]) groups[m.providerName] = []
    groups[m.providerName].push({ id: m.id, name: m.name })
  }
  return Object.entries(groups).flatMap(([, models]) =>
    models.map(m => ({ label: m.name, value: m.id })),
  )
})

function onStrategyChange(val: string) {
  emit('update:strategy', val as 'auto' | 'tag' | 'bind')
}

function onTagChange(tag: 'power' | 'efficient' | 'fast', val: string) {
  emit('update:modelTags', { ...props.modelTags!, [tag]: val })
}

function onBindChange(val: string) {
  emit('update:modelBind', val)
}
</script>

<template>
  <div class="model-config__title">模型适配</div>
  <div class="model-config">
    <div class="model-config__row">
      <span class="model-config__row-label">策略</span>
      <Select
        class="model-config__select"
        :model-value="strategy"
        :options="strategyOptions"
        @update:model-value="onStrategyChange"
      />
    </div>
    <!-- Tag rows -->
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">强力模型</span>
      <Select
        class="model-config__select"
        :model-value="modelTags?.power ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('power', $event)"
      />
    </div>
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">高效模型</span>
      <Select
        class="model-config__select"
        :model-value="modelTags?.efficient ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('efficient', $event)"
      />
    </div>
    <div v-if="strategy === 'tag'" class="model-config__row">
      <span class="model-config__row-label">快速模型</span>
      <Select
        class="model-config__select"
        :model-value="modelTags?.fast ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('fast', $event)"
      />
    </div>
    <!-- Bind row -->
    <div v-if="strategy === 'bind'" class="model-config__row">
      <span class="model-config__row-label">绑定模型</span>
      <Select
        class="model-config__select"
        :model-value="modelBind ?? ''"
        :options="bindModelOptions"
        @update:model-value="onBindChange"
      />
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
}
</style>
