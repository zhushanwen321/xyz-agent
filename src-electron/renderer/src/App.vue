<template>
  <!-- 连接前只显窗口 + logo（不闪现 Sparkles 空态）；连接后渲染 AppShell。
       mock 模式连接快（200ms）；真 runtime 端口发现可能更久，logo 态是必要的过渡屏。 -->
  <div v-if="connectionState !== 'connected'" class="connecting-screen grid h-screen w-screen place-items-center bg-bg">
    <div class="flex flex-col items-center gap-4">
      <span class="grid size-12 place-items-center rounded-xl bg-accent text-2xl font-bold text-white">x</span>
      <span class="text-[12.5px] text-subtle">连接中…</span>
    </div>
  </div>
  <template v-else>
    <!-- L0 Shell 挂载点。traffic light 安全区在 AsideRegion 内（padding-top:52px，spec §三）。 -->
    <AppShell />
  </template>
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
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session。
// useConnection.init 是 fire-and-forget（connect 异步），return 时连接未握手指；state==='connected'
// 是「连接成功」唯一可靠信号——watch 它触发 initApp，appBootstrapped 守卫保证 HMR/重连幂等。
const { initApp } = useSidebar()
onMounted(() => { void init() })
watch(connectionState, (s) => {
  if (s === 'connected') void initApp()
})
onBeforeUnmount(() => teardown())
</script>
