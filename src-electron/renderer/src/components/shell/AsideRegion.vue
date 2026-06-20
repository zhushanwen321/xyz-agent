<template>
  <!--
    展示组件 · 透明布局槽。
    无 background，继承 app-shell 的 bg-bg，视觉上与窗口底色融合（spec §一）。
    Wave 3：在此挂载 Sidebar 容器（FG3），padding-top:52px 安全区让出 traffic light。
  -->
  <aside class="aside-region flex flex-shrink-0 flex-col">
    <Sidebar />
  </aside>
</template>

<script setup lang="ts">
// 纯展示：无 props / 无 store 依赖。
// 尺寸值放 scoped style（Tailwind 无 pt-13/w-50 精确类，escape hatch）。
import Sidebar from '@/components/sidebar/Sidebar.vue'
</script>

<style scoped>
/*
 * padding-top:52px = mac traffic light 安全区（spec §三：32 安全区 + 20 呼吸）。
 * 三平台恒定（spec §五），全屏也保留——mac 系统下拉覆盖层会落进这块留白。
 * width:200px = sidebar 展开态宽度；折叠态宽度 spec 未定（属 L2），待 Wave 3 sidebar store 接入。
 */
.aside-region {
  width: 200px;
  padding-top: 52px;
}
</style>
