<!--
  SessionsShellSm —— w5 首屏冒烟临时测试壳组件（TC-6 渲染 gate）。
  setup 调 useSidebarNew()，渲染 session 列表 + focused chip，defineExpose sidebar 供测试读状态。
  非生产组件——仅 w5 冒烟测试消费，消费方切换 wave 后随 useSidebarNew 一并归位/删除。
-->
<script setup lang="ts">
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'

const sidebar = useSidebarNew()

function pick(id: string): void {
  void sidebar.selectSession(id)
}

defineExpose({ sidebar })
</script>

<template>
  <div class="sessions-shell-sm">
    <div data-testid="focused-chip">
      {{ sidebar.focusedSession.value?.label ?? '(no focus)' }}
    </div>
    <ul data-testid="session-list">
      <li
        v-for="s in sidebar.__testStore.list.value"
        :key="s.id"
        data-testid="session-item"
        :data-id="s.id"
        @click="pick(s.id)"
      >
        {{ s.label }}
      </li>
    </ul>
  </div>
</template>
