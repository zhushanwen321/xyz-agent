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
import { watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useSidebar } from '@/composables/features/useSidebar'
import AsideRegion from './AsideRegion.vue'
import MainPanel from './MainPanel.vue'

const navigation = useNavigationStore()
const session = useSessionStore()
const { syncSessionToPanel } = useSidebar()

// 平台 + 全屏态同步到 <html>（data-platform / data-fullscreen），驱动 traffic-light / app-nav-controls 两态。
usePlatformChrome()

// 导航栈指针变化 → 同步 session.activeId + panel 载入（shell spec §八.5 G3-003「历史状态正确恢复」）。
// 覆盖 ⌘[/⌘] 与 AppNavControls 后退/前进：pointer 变后若落在 chat+sessionId 条目，恢复该 session 到 panel。
// overview/settings 条目不动 session（main 区被覆盖，保留上次 chat session 供回退）。
// selectSession 主路径已立即同步，此 watch 兜底导航回退/前进；syncSessionToPanel 幂等，重复调用无副作用。
watch(
  () => navigation.pointer,
  () => {
    const cur = navigation.current
    if (cur.view === 'chat' && cur.sessionId) {
      session.activeId = cur.sessionId
      syncSessionToPanel(cur.sessionId)
    }
  },
)

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
