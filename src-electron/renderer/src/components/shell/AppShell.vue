<template>
  <!--
    L0 Shell · zcode-demo 拓扑（shell/spec.md SSOT）
    base 平铺（bg-bg）+ aside 透明融合 + main float-panel 浮起。
    traffic light 安全区在 AsideRegion 内（padding-top:52px 恒定，spec §三）。
  -->
  <div class="app-shell flex h-screen w-screen gap-3 bg-bg p-3">
    <AsideRegion />
    <MainPanel />
  </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { useNavigationStore } from '@/stores/navigation'
import AsideRegion from './AsideRegion.vue'
import MainPanel from './MainPanel.vue'

const navigation = useNavigationStore()

// ⌘[/⌘] 导航历史快捷键（shell spec §八.5 G3-003）。
// mac ⌘ / win·linux Ctrl，跨平台统一；canBack/canForward 为 false 时静默不触发。
// useEventListener 自动在组件卸载时移除监听。
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  if (e.key === '[') {
    if (navigation.canBack) {
      e.preventDefault()
      navigation.back()
    }
  } else if (e.key === ']') {
    if (navigation.canForward) {
      e.preventDefault()
      navigation.forward()
    }
  }
})
</script>
