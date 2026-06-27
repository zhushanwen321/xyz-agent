<template>
  <!-- L0 Shell 挂载点。traffic light 安全区在 AsideRegion 内（padding-top:52px，spec §三）。 -->
  <AppShell />
  <ToastContainer />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { useConnection } from '@/composables/useConnection'
import { useSidebar } from '@/composables/features/useSidebar'

// 应用挂载即初始化连接（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
const { state: connectionState, init, teardown } = useConnection()
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session（G1.1）。
// useConnection.init 是 fire-and-forget（connect 异步），return 时连接未握手指；state==='connected'
// 是「连接成功」唯一可靠信号——watch 它触发 initApp，appBootstrapped 守卫保证 HMR/重连幂等。
const { initApp } = useSidebar()
onMounted(() => { void init() })
watch(connectionState, (s) => {
  if (s === 'connected') void initApp()
})
onBeforeUnmount(() => teardown())
</script>
