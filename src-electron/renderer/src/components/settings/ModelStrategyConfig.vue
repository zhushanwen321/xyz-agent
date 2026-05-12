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
  <div class="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted mb-2">模型适配</div>
  <div class="overflow-hidden mb-3">
    <div class="flex items-center gap-3 py-2 border-b border-[oklch(92%_0.01_70)] last:border-b-0">
      <span class="text-xs min-w-[60px] font-medium">策略</span>
      <Select
        class="!h-8 !px-2.5 !py-1.5 !text-xs !rounded"
        :model-value="strategy"
        :options="strategyOptions"
        style="max-width: 200px"
        @update:model-value="onStrategyChange"
      />
    </div>
    <!-- Tag rows -->
    <div v-if="strategy === 'tag'" class="flex items-center gap-3 py-2 border-b border-[oklch(92%_0.01_70)] last:border-b-0">
      <span class="text-xs min-w-[60px] font-medium">强力模型</span>
      <Select
        class="!h-8 !px-2.5 !py-1.5 !text-xs !rounded"
        :model-value="modelTags?.power ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('power', $event)"
      />
    </div>
    <div v-if="strategy === 'tag'" class="flex items-center gap-3 py-2 border-b border-[oklch(92%_0.01_70)] last:border-b-0">
      <span class="text-xs min-w-[60px] font-medium">高效模型</span>
      <Select
        class="!h-8 !px-2.5 !py-1.5 !text-xs !rounded"
        :model-value="modelTags?.efficient ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('efficient', $event)"
      />
    </div>
    <div v-if="strategy === 'tag'" class="flex items-center gap-3 py-2 border-b border-[oklch(92%_0.01_70)] last:border-b-0">
      <span class="text-xs min-w-[60px] font-medium">快速模型</span>
      <Select
        class="!h-8 !px-2.5 !py-1.5 !text-xs !rounded"
        :model-value="modelTags?.fast ?? ''"
        :options="allModelOptions"
        @update:model-value="onTagChange('fast', $event)"
      />
    </div>
    <!-- Bind row -->
    <div v-if="strategy === 'bind'" class="flex items-center gap-3 py-2 border-b border-[oklch(92%_0.01_70)] last:border-b-0">
      <span class="text-xs min-w-[60px] font-medium">绑定模型</span>
      <Select
        class="!h-8 !px-2.5 !py-1.5 !text-xs !rounded"
        :model-value="modelBind ?? ''"
        :options="bindModelOptions"
        @update:model-value="onBindChange"
      />
    </div>
  </div>
</template>


