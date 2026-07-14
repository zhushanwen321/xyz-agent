<template>
  <!-- 非连接态分三种展示：
       - connecting/disconnected/reconnecting：logo + 「连接中…」（过渡屏）
       - restarting：logo + 「runtime 重启中…」（崩溃自动恢复，主进程在拉起新实例）
       - failed：logo + 错误提示 + 重试按钮（自动重启用尽，需用户手动触发）
       连接后渲染 AppShell。 -->
  <div v-if="connectionState !== 'connected'" class="connecting-screen grid h-screen w-screen place-items-center bg-bg">
    <div class="flex flex-col items-center gap-4">
      <span class="grid size-12 place-items-center rounded-xl bg-accent text-2xl font-bold text-white">x</span>
      <!-- runtime 重启中 -->
      <template v-if="connectionState === 'restarting'">
        <Loader2 class="size-4 animate-spin text-subtle" />
        <span class="text-[12.5px] text-subtle">runtime 重启中…</span>
      </template>
      <!-- runtime 重启用尽，需手动重试 -->
      <template v-else-if="connectionState === 'failed'">
        <AlertCircle class="size-5 text-danger" />
        <span class="text-[12.5px] text-muted">runtime 不可用，重试多次仍失败</span>
        <Button variant="default" size="sm" data-testid="runtime-retry-btn" @click="onRetry">
          重试
        </Button>
      </template>
      <!-- 默认连接中（connecting/disconnected/reconnecting） -->
      <span v-else class="text-[12.5px] text-subtle">连接中…</span>
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
import { Loader2, AlertCircle } from '@lucide/vue'
import AppShell from '@/components/shell/AppShell.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { Button } from '@/components/ui/button'
import { useConnection } from '@/composables/useConnection'
import { useSidebar } from '@/composables/features/useSidebar'

// 应用挂载即初始化连接（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
const { state: connectionState, init, teardown, retryRuntime } = useConnection()
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session。
// useConnection.init 是 fire-and-forget（connect 异步），return 时连接未握手指；state==='connected'
// 是「连接成功」唯一可靠信号——watch 它触发 onConnected，appBootstrapped 守卫保证 HMR/重连幂等。
const { onConnected } = useSidebar()
onMounted(() => { void init() })
// [W8] onConnected 内部用模块级 hasConnectedBefore 区分首次 vs 重连：
// - 首次 connected → initApp（内部含 workspaceStore.load + presetCwd）
// - 重连 connected → initApp 因 appBootstrapped 守卫直接 return，records 停留在断连前 stale 数据
//   （runtime 可能重启后从磁盘重载了新记录，如另一窗口写入），故额外 fire-and-forget load() 刷新。
//   hasConnectedBefore 与 appBootstrapped 同为模块级，组件卸载重挂（非模块重载）时保留值，
//   避免新实例误判为「首次」再调 initApp（被守卫吞）导致 load 不刷新。
watch(connectionState, (s) => {
  if (s === 'connected') void onConnected()
})

/** 用户点击「重试」：委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
 *  重启成功后 supervisor 广播 runtime-port，onRuntimePort 监听自动重连 → 回到 connected。 */
function onRetry(): void {
  void retryRuntime()
}

onBeforeUnmount(() => teardown())
</script>
