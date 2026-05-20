<template>
  <div class="flex border-b border-border">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      :class="['flex-1 py-[9px] px-2 text-[11px] font-semibold text-center cursor-pointer border-b-2 select-none transition-[color,border-color] duration-150 ease-ease', activeTab === tab.id ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-fg']"
      @click="$emit('update:active-tab', tab.id)"
    >
      {{ tab.label }}
      <span v-if="tab.count > 0" :class="['inline-flex items-center justify-center min-w-[16px] h-4 rounded-full text-[10px] font-bold ml-[3px] px-1', tab.type === 'done' ? 'bg-success-light text-success' : tab.type === 'alert' ? 'bg-danger-light text-danger' : '']">
        {{ tab.count }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export type InspectorTabId = 'tree' | 'done' | 'alert'

const props = defineProps<{
  activeTab: InspectorTabId
  doneCount: number
  alertCount: number
}>()

defineEmits<{
  'update:active-tab': [value: InspectorTabId]
}>()

const tabs = computed(() => [
  { id: 'tree' as InspectorTabId, label: '任务树', count: 0, type: '' },
  { id: 'done' as InspectorTabId, label: '已完成', count: props.doneCount, type: 'done' },
  { id: 'alert' as InspectorTabId, label: '请求回应', count: props.alertCount, type: 'alert' },
])
</script>
