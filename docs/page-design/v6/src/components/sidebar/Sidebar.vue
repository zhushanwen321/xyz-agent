<script setup lang="ts">
/** Sidebar 入口组件（容器总览，spec §1）。
 *  底色 = var(--bg) [= --bg-sunken]，无 border-r，靠主面板 surface 浮起分隔。
 *  结构：Brand → nav（新建/搜索）→ SegmentedTab → 子视图（按 tab 切）→ UserArea。 */

import { sidebarTab, openSearch } from '@/composables/useStore'
import Brand from './Brand.vue'
import NavItem from './NavItem.vue'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import FileTreeView from './FileTreeView.vue'
import SubagentList from './SubagentList.vue'
import WorkflowListView from './WorkflowListView.vue'
import PluginPanel from './PluginPanel.vue'
import UserArea from './UserArea.vue'

function onNewTask() {
  // 新建任务：落到当前 sessions tab + 提示（demo 占位，真实走 command bus）
  sidebarTab.value = 'sessions'
}
</script>

<template>
  <div class="sidebar">
    <Brand />

    <nav class="sidebar__nav">
      <NavItem icon="plus" label="新建任务" kbd="⌘N" @click="onNewTask" />
      <NavItem icon="search" label="搜索" kbd="⌘K" @click="openSearch" />
    </nav>

    <div class="sidebar__hr"></div>

    <SegmentedTab />

    <div class="sidebar__content">
      <SessionList v-if="sidebarTab === 'sessions'" />
      <FileTreeView v-else-if="sidebarTab === 'files'" />
      <SubagentList v-else-if="sidebarTab === 'subagents'" />
      <WorkflowListView v-else-if="sidebarTab === 'workflows'" />
      <PluginPanel v-else />
    </div>

    <UserArea />
  </div>
</template>

<style scoped>
.sidebar {
  /* 容器底色 = bg-sunken（画布色，与窗口同色融合），无 border-r */
  background: var(--bg-sunken);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  padding: 4px 4px 8px;
}
.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 4px;
}
.sidebar__hr {
  height: 1px;
  background: var(--border);
  margin: 8px 10px;
}
.sidebar__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
