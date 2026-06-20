<template>
  <!--
    容器组件 · float-panel 浮起（spec §一：唯一带 bg/border/radius/shadow 的面板）。
    靠 background+border+shadow 视觉浮起，不靠 z-index。
    view 路由：chat → Workspace（FG4），overview/settings → FG6 待接入。
  -->
  <main class="main-panel flex flex-1 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
    <Workspace v-if="navigation.current.view === 'chat'" />
    <div
      v-else
      class="flex flex-1 items-center justify-center text-sm text-subtle"
    >
      view: {{ navigation.current.view }} 待 FG6 接入
    </div>
  </main>
</template>

<script setup lang="ts">
import { useNavigationStore } from '@/stores/navigation'
import Workspace from '@/components/workspace/Workspace.vue'

const navigation = useNavigationStore()
</script>

<style scoped>
/* float-panel 浮起：描边（shadow-1）+ 浮层（shadow-2）双 shadow 叠加。
 * Tailwind 单 box-shadow 属性无法用两个类叠加，走 escape hatch 用 CSS 变量组合。 */
.main-panel {
  box-shadow: var(--shadow-1), var(--shadow-2);
}
</style>
