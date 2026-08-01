<script setup lang="ts">
import TrafficLight from '@/components/shell/TrafficLight.vue'
import AppNavControls from '@/components/shell/AppNavControls.vue'
import PanelHeader from '@/components/shell/PanelHeader.vue'
import SplitterHandle from '@/components/shell/SplitterHandle.vue'
import Sidebar from '@/components/sidebar/Sidebar.vue'
import MessageStream from '@/components/chat/MessageStream.vue'
import Composer from '@/components/composer/Composer.vue'
import SideDrawer from '@/components/drawer/SideDrawer.vue'
import { sidebarCollapsed, drawerOpen } from '@/composables/useStore'
</script>

<template>
  <div class="stage">
    <div class="window-frame" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
      <!-- traffic-light 安全区 -->
      <TrafficLight />
      <AppNavControls />

      <!-- aside 侧栏 -->
      <aside class="aside-region" :class="{ collapsed: sidebarCollapsed }">
        <Sidebar />
      </aside>

      <!-- splitter -->
      <SplitterHandle v-if="!sidebarCollapsed" />

      <!-- main panel（surface 浮起，唯一带 border + shadow）-->
      <main class="main-panel">
        <PanelHeader />
        <div class="main-body">
          <!-- workspace（对话流 + composer）-->
          <div class="workspace">
            <MessageStream />
            <Composer />
          </div>
          <!-- drawer（与 main 同 surface 浮起体）：width 过渡（320ms），DOM 常驻保 terminal 等状态 -->
          <div class="drawer-wrap" :class="{ open: drawerOpen }">
            <SplitterHandle class="drawer-splitter" />
            <SideDrawer class="drawer-pane" />
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.stage {
  width: 100%;
  height: 100%;
  background: #131316;
  display: flex;
  padding: 12px;
}

.window-frame {
  flex: 1;
  display: flex;
  gap: 12px;
  background: var(--bg);
  border-radius: 10px;
  padding: 12px;
  position: relative;
  overflow: hidden;
}

/* aside 区域：画布色（bg-sunken），padding-top 留 traffic-light 安全区 */
.aside-region {
  flex: 0 0 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding-top: 52px; /* traffic-light 安全区，恒定 */
  transition: flex-basis var(--duration-slow) var(--ease);
}
.aside-region.collapsed {
  flex-basis: 0;
  overflow: hidden;
}

/* main panel：surface 浮起 */
.main-panel {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1), var(--shadow-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.window-frame.sidebar-collapsed {
  gap: 0;
}

/* drawer wrapper：width 0 → 360px 平滑过渡（320ms），DOM 常驻保 terminal 等状态。
 * 内部 SideDrawer 始终挂载；关闭时宽度收缩到 0 + overflow:hidden 实现 320ms 过渡。*/
.drawer-wrap {
  flex: 0 0 auto;
  width: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
  transition: width var(--duration-slow) var(--ease);
}
.drawer-wrap.open {
  width: 360px;
}
.drawer-splitter {
  flex: 0 0 auto;
}
.drawer-pane {
  flex: 1;
  min-width: 0;
}
</style>
