<template>
  <!--
    L0 Shell · zcode-demo 拓扑（shell/spec.md SSOT）
    base 平铺（bg-bg）+ aside 透明融合 + main float-panel 浮起。
    traffic light 安全区在 AsideRegion 内（padding-top:52px 恒定，spec §三）。
  -->
  <!-- gap 折叠态→0：aside 归零后 gap 仍占位会让 MainPanel 左缘=24（右缘=12）不对称。
       折叠态 gap:0 使 MainPanel 左右边距对称（各 12px = p-3），workspace 居中贴窗口边。
       !important 必须：gap-0 与 gap-3 同特异性，Tailwind 源码顺序 gap-0 先于 gap-3 生成，
       不加 ! 会被 gap-3 永久覆盖（死代码 bug）。 -->
  <div
    class="app-shell relative flex h-screen w-screen gap-3 overflow-hidden rounded-[10px] bg-bg p-3"
    :class="sidebar.collapsed ? '!gap-0' : ''"
  >
    <AsideRegion />
    <AppNavControls />
    <MainPanel />
    <SettingsModal v-model:open="settingsOpen" />
  </div>
</template>

<script setup lang="ts">
import { provide, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useSettings } from '@/composables/features/useSettings'
import { useSidebar } from '@/composables/features/useSidebar'
import AppNavControls from './AppNavControls.vue'
import AsideRegion from './AsideRegion.vue'
import MainPanel from './MainPanel.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import { useSidebarStore } from '@/stores/sidebar'

const navigation = useNavigationStore()
const session = useSessionStore()
const sidebar = useSidebarStore()
const { syncSessionToPanel } = useSidebar()

/** Settings modal 开关（⌘, / sidebar 用户区触发） */
const settingsOpen = ref(false)
provide('openSettings', () => { settingsOpen.value = true })

// 平台 + 全屏态同步到 <html>（data-platform / data-fullscreen），驱动 traffic-light / app-nav-controls 两态。
usePlatformChrome()

// Settings 域订阅编排：useSettings.init 挂载 7 域常驻订阅 + 同步 system 偏好到 DOM(data-theme)/i18n。
// 幂等（模块级 initialized 去重）；订阅随 AppShell 生命周期常驻，settings store 数据全局可消费。
// fire-and-forget：init 内部已处理订阅挂载，无需 await 阻塞渲染。
const { init: initSettings } = useSettings()
void initSettings()

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
  } else if (e.key === ',') {
    // ⌘, 打开 Settings（settings/spec.md §1）
    e.preventDefault()
    settingsOpen.value = true
  }
})
</script>
