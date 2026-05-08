<template>
  <aside class="drawer drawer--left" :class="{ open }">
    <div class="drawer__hd">
      <div class="drawer__title">SubAgent 监控</div>
      <Button variant="ghost" class="drawer__close" @click="$emit('close')">&times;</Button>
    </div>
    <DrawerTabs
      :active-tab="activeTab"
      :done-count="doneItems.length"
      :alert-count="alertItems.length"
      @update:active-tab="activeTab = $event"
    />
    <div class="drawer__body">
      <div :class="['drawer-pane', { active: activeTab === 'tree' }]">
        <TaskTree
          :nodes="treeNodes"
          :active-node-id="activeNodeId"
          @navigate="$emit('navigate', $event)"
          @kill="$emit('kill', $event)"
        />
      </div>
      <div :class="['drawer-pane', { active: activeTab === 'done' }]">
        <DoneItem
          v-for="item in doneItems"
          :key="item.id"
          v-bind="item"
          @view="$emit('view-done', item.id)"
        />
      </div>
      <div :class="['drawer-pane', { active: activeTab === 'alert' }]">
        <AlertItem
          v-for="item in alertItems"
          :key="item.id"
          v-bind="item"
          @reply="$emit('reply', $event)"
          @view="$emit('view-alert', item.id)"
        />
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '../../design-system'
import DrawerTabs from './DrawerTabs.vue'
import TaskTree from './TaskTree.vue'
import DoneItem from './DoneItem.vue'
import AlertItem from './AlertItem.vue'

interface TreeNode {
  id: string
  label: string
  status?: string
  meta?: string
  children?: TreeNode[]
}

interface DoneItemData {
  id: string
  name: string
  summary: string
  duration?: string
}

interface AlertItemData {
  id: string
  name: string
  session?: string
  time?: string
  question: string
  simple?: boolean
}

defineProps<{
  open: boolean
  treeNodes: TreeNode[]
  doneItems: DoneItemData[]
  alertItems: AlertItemData[]
  activeNodeId: string
}>()

defineEmits<{
  close: []
  navigate: [nodeId: string]
  kill: [nodeId: string]
  'view-done': [itemId: string]
  'view-alert': [itemId: string]
  reply: [payload: { id: string; message: string }]
}>()

const activeTab = ref<'tree' | 'done' | 'alert'>('tree')
</script>

<style scoped>
.drawer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--drawer-w);
  background: var(--surface);
  z-index: 50;
  display: flex;
  flex-direction: column;
  transition: transform 0.3s var(--ease);
}

.drawer--left {
  left: 0;
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
}

.drawer.open {
  transform: translateX(0);
}

.drawer__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.drawer__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
}

.drawer__close {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s var(--ease);
}

.drawer__close:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.drawer__body {
  flex: 1;
  overflow-y: auto;
}

.drawer-pane {
  display: none;
  padding: 12px;
}

.drawer-pane.active {
  display: block;
}
</style>
