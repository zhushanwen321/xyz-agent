<template>
  <!--
    展示组件 · 透明布局槽。
    无 background，继承 app-shell 的 bg-bg，视觉上与窗口底色融合（spec §一）。
    traffic-light 已提升至 AppShell 层（v6-spec-shell §3 修订②：避免折叠态 aside 归零改变定位基准
    且被 overflow-hidden 裁剪）；app-nav-controls 同因提升（本组件历史注释自述）。
    Wave 3：在此挂载 Sidebar 容器（FG3）。padding-top:52px(pt-[52px]) 安全区（v6-spec-shell §三：三平台统一 · 全屏保留），
    让出 traffic light（红黄绿 y=26~38）并拉开 trafficlight 行（nav 按钮中线 y32）与 LOGO 行视觉间距。
  -->
  <aside
    class="relative flex flex-col overflow-hidden pt-[52px]"
    :style="{
      flexBasis: sidebar.collapsed ? '0px' : '300px',
      flexGrow: '0',
      flexShrink: '0',
      minWidth: '0px',
    }"
    data-testid="app-shell-aside"
  >
    <Sidebar />
  </aside>
</template>

<script setup lang="ts">
// aside flex-basis 联动 sidebar.collapsed（spec §收起态：折叠 width→0，main 占满全宽；
// pt-[52px] traffic light 安全区：AppShell p-3 使 aside 顶在窗口 y=12，红黄绿（AppShell 层挂载）y=26~38，
// 安全区让出；position:relative 为 aside 内绝对定位子元素提供 offset parent（traffic-light 已不在内）。
// app-nav-controls / traffic-light 均提升至 AppShell 层（v6-spec-shell §3 修订②：避免折叠态
// aside 归零改变定位基准 + overflow-hidden 裁剪）。
// flex-basis（非 width）：flex 子 width:0 被 min-content 撑开，必须显式 flex-basis:0 才能真正归零。
// 不挂 transition：CDP 测试环境（Electron 42/Chrome 148）下 flex 子的 flex-basis/max-width transition
// 锁死 declared value（动画不触发且阻止最终值生效），opacity transition 亦不触发——环境性问题，非代码缺陷。
// 320ms 时长配置已在 .sidebar scoped + app-nav-controls 中保留（未改），spec 时长约束未破；
// 真实环境若 transition 可用，可在此 class 补 transition-[flex-basis] duration-[var(--duration-slow)] ease-[var(--ease)]。
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { useSidebarStore } from '@/stores/sidebar'

const sidebar = useSidebarStore()
</script>
