<template>
  <!--
    L0 Shell · zcode-demo 拓扑（shell/spec.md SSOT）
    base 平铺（bg-bg）+ aside 透明融合 + main float-panel 浮起。
    traffic light 安全区在 AsideRegion 内（padding-top:52px 恒定，spec §三）。
  -->
  <!-- padding：左右 px-2(8) 使 aside 左缘 x=8 对齐红黄绿左缘；上下 py-0 让 main-panel 贴窗口顶/底（极限紧凑，原生 mac 感）。
       gap 折叠态→0 + !p-0：收起态 aside 归零、main-panel 四周全贴窗口边（极限，用户要求「非常极限可接受」）。
       !important 必须：gap-0/p-0 与 gap-3/px-2 同特异性，Tailwind 源码顺序前者先于后者生成，
       不加 ! 会被后者永久覆盖（死代码 bug）。 -->
  <div
    class="app-shell relative flex h-screen w-screen gap-3 overflow-hidden rounded-[10px] bg-bg px-2"
    :class="sidebar.collapsed ? '!gap-0 !p-0' : ''"
    data-testid="app-shell"
  >
    <AsideRegion />
    <AppNavControls />
    <MainPanel />
    <SettingsModal v-model:open="settingsOpen" />
  </div>
</template>

<script setup lang="ts">
import { provide, ref, watch } from 'vue'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useSettingsShell } from '@/composables/shell/useSettingsShell'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import AppNavControls from './AppNavControls.vue'
import AsideRegion from './AsideRegion.vue'
import MainPanel from './MainPanel.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import { useSidebarStore } from '@/stores/sidebar'

const navigation = useNavigationStore()
const session = useSessionStore()
const sidebar = useSidebarStore()
const { syncSessionToPanel } = useSidebarNew()

/** Settings modal 开关（⌘, / sidebar 用户区触发） */
const settingsOpen = ref(false)
provide('openSettings', () => { settingsOpen.value = true })

// 平台 + 全屏态同步到 <html>（data-platform / data-fullscreen），驱动 traffic-light / app-nav-controls 两态。
usePlatformChrome()

// Settings 域壳接入（W4）：providePlatform + provideSettingsTransport + core useSettings().init
// （挂常驻订阅 + 同步 system 偏好）+ provide 3 个 ui 注入 key + watch system.theme 挂/卸 matchMedia。
// core 零 DOM；壳持 platform/transport 注入 + DOM 副作用。幂等（core 模块级单例）。
useSettingsShell()

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
</script>
