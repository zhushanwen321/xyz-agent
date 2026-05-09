<template>
  <div class="drawer-tabs">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      :class="['drawer-tab', { active: activeTab === tab.id }]"
      @click="$emit('update:active-tab', tab.id)"
    >
      {{ tab.label }}
      <span v-if="tab.count > 0" :class="['drawer-tab__count', `drawer-tab__count--${tab.type}`]">
        {{ tab.count }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export type DrawerTabId = 'tree' | 'done' | 'alert'

const props = defineProps<{
  activeTab: DrawerTabId
  doneCount: number
  alertCount: number
}>()

defineEmits<{
  'update:active-tab': [value: DrawerTabId]
}>()

const tabs = computed(() => [
  { id: 'tree' as DrawerTabId, label: '任务树', count: 0, type: '' },
  { id: 'done' as DrawerTabId, label: '已完成', count: props.doneCount, type: 'done' },
  { id: 'alert' as DrawerTabId, label: '请求回应', count: props.alertCount, type: 'alert' },
])
</script>
