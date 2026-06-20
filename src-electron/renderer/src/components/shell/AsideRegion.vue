<template>
  <!--
    展示组件 · 透明布局槽。
    无 background，继承 app-shell 的 bg-bg，视觉上与窗口底色融合（spec §一）。
    traffic light + app-nav-controls 绝对定位在此组件顶部安全区（spec §六 z-index:10）。
    Wave 3：在此挂载 Sidebar 容器（FG3），padding-top:52px 安全区让出 traffic light。
  -->
  <aside class="aside-region relative flex w-[200px] flex-shrink-0 flex-col pt-[52px]">
    <TrafficLight />
    <AppNavControls />
    <Sidebar />
  </aside>
</template>

<script setup lang="ts">
// 纯展示：无 props / 无 store 依赖（TrafficLight/AppNavControls 自管状态）。
// 尺寸值内联 Tailwind：w-[200px] sidebar 展开态宽度，pt-[52px] mac traffic light 安全区。
// position:relative（relative 类）= traffic-light / app-nav-controls 绝对定位的 offset parent。
import Sidebar from '@/components/sidebar/Sidebar.vue'
import TrafficLight from './TrafficLight.vue'
import AppNavControls from './AppNavControls.vue'
</script>
