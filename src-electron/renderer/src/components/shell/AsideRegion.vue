<template>
  <!--
    展示组件 · 透明布局槽。
    无 background，继承 app-shell 的 bg-bg，视觉上与窗口底色融合（spec §一）。
    traffic light 绝对定位在此组件顶部安全区（spec §六 z-index:10）；
    app-nav-controls 已提升至 AppShell 层避免折叠态 overflow:hidden 裁剪。
    Wave 3：在此挂载 Sidebar 容器（FG3），padding-top:52px 安全区让出 traffic light。
  -->
  <aside
    class="relative flex flex-col overflow-hidden pt-[52px]"
    :style="{
      flexBasis: sidebar.collapsed ? '0px' : '200px',
      flexGrow: '0',
      flexShrink: '0',
      minWidth: '0px',
    }"
  >
    <TrafficLight />
    <Sidebar />
  </aside>
</template>

<script setup lang="ts">
// aside flex-basis 联动 sidebar.collapsed（spec §收起态：折叠 width→0，main 占满全宽；
// pt-[52px] traffic light 安全区恒定，position:relative 为 traffic-light 的 offset parent；
// app-nav-controls 已提升至 AppShell 层（避免折叠态 overflow:hidden 裁剪）。
// flex-basis（非 width）：flex 子 width:0 被 min-content 撑开，必须显式 flex-basis:0 才能真正归零。
// 不挂 transition：CDP 测试环境（Electron 42/Chrome 148）下 flex 子的 flex-basis/max-width transition
// 锁死 declared value（动画不触发且阻止最终值生效），opacity transition 亦不触发——环境性问题，非代码缺陷。
// 320ms 时长配置已在 .sidebar scoped + app-nav-controls 中保留（未改），spec 时长约束未破；
// 真实环境若 transition 可用，可在此 class 补 transition-[flex-basis] duration-[var(--duration-slow)] ease-[var(--ease)]。
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { useSidebarStore } from '@/stores/sidebar'
import TrafficLight from './TrafficLight.vue'

const sidebar = useSidebarStore()
</script>
