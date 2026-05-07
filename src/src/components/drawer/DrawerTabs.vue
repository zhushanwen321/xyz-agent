<template>
  <div class="drawer-tabs">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      :class="['drawer-tab', { active: activeTab === tab.id }]"
      @click="$emit('update:activeTab', tab.id)"
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
  'update:activeTab': [value: DrawerTabId]
}>()

const tabs = computed(() => [
  { id: 'tree' as DrawerTabId, label: '任务树', count: 0, type: '' },
  { id: 'done' as DrawerTabId, label: '已完成', count: props.doneCount, type: 'done' },
  { id: 'alert' as DrawerTabId, label: '请求回应', count: props.alertCount, type: 'alert' },
])
</script>

<style scoped>
.drawer-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}

.drawer-tab {
  flex: 1;
  padding: 9px 8px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s var(--ease), border-color 0.15s var(--ease);
  user-select: none;
}

.drawer-tab:hover {
  color: var(--fg);
}

.drawer-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.drawer-tab__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  margin-left: 3px;
  padding: 0 4px;
}

.drawer-tab__count--done {
  background: var(--success-light);
  color: var(--success);
}

.drawer-tab__count--alert {
  background: var(--danger-light);
  color: var(--danger);
}
</style>
