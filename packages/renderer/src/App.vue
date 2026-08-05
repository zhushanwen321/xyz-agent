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
        <Loader2 class="size-4 animate-spin text-neutral-dim" />
        <span class="text-[12.5px] text-neutral-dim">{{ t('connection.restarting') }}</span>
      </template>
      <!-- runtime 重启用尽，需手动重试 -->
      <template v-else-if="connectionState === 'failed'">
        <AlertCircle class="size-5 text-danger" />
        <span class="text-[12.5px] text-neutral-mid">{{ t('connection.failed') }}</span>
        <Button variant="default" size="sm" data-testid="runtime-retry-btn" @click="onRetry">
          {{ t('connection.retry') }}
        </Button>
      </template>
      <!-- 默认连接中（connecting/disconnected/reconnecting） -->
      <span v-else class="text-[12.5px] text-neutral-dim">{{ t('connection.connecting') }}</span>
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
import { useI18n } from 'vue-i18n'
import AppShell from '@/components/shell/AppShell.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { Button } from '@/components/ui/button'
import { useConnection } from '@/composables/useConnection'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import { bootstrapSettingsCore } from '@/composables/shell/useSettingsShell'
import { useSettings } from '@xyz-agent/core'
import { bindForkNoticeEffect } from '@/composables/effects/useForkNoticeEffect'
import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import { bindSessionStreamSync } from '@/composables/effects/useSessionStreamSync'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'

// 应用挂载即初始化连接（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
// settings 域核心初始化（platform + transport + 订阅注册）必须在 WS 连接前完成：
// AppShell 仅在 connected 后渲染，若订阅注册留在 AppShell setup 会晚于 sendInitialState 首推 →
// 首条 model.list / config.defaults 丢失 → settingsStore.models / defaultModel 永空
// （模型选择器下拉空 + landing 按钮文案空，[HISTORICAL] 2026-08-05）。
bootstrapSettingsCore()

const { t } = useI18n()
const { state: connectionState, init, teardown, retryRuntime } = useConnection()
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session。
// useConnection.init 是 fire-and-forget（connect 异步），return 时连接未握手指；state==='connected'
// 是「连接成功」唯一可靠信号——watch 它触发 onConnected，appBootstrapped 守卫保证 HMR/重连幂等。
const { onConnected } = useSidebarNew()
// settings 订阅的 dispose（HMR/App 卸载销毁）+ models 兜底拉取（防订阅时序竞态）。
// 订阅注册在 bootstrapSettingsCore（上见），此处只持有 dispose/refreshModels 句柄。
const { dispose: disposeSettings, refreshModels } = useSettings()
// RV1+RV2：fork 反馈行 + 后台分支通知全局订阅（session.forkNotice 广播 → transient feed；
// useForkBranchNotify diff 分支状态 → 状态变化反馈行）。App setup 是全局 effect 作用域，
// onScopeDispose 随 App 卸载退订（单实例，与 events.onGlobalType 范式一致）。
bindForkNoticeEffect()
// fast-handoff：订阅 session.handoffComplete 广播 → 复位源 session handingOff 态 + 刷新列表 + 跳转新 session。
// 与 bindForkNoticeEffect 同范式（effect 层订阅，非 useChat switch）。onScopeDispose 随 App 卸载退订。
bindHandoffEffect()
// session 全量事件订阅编排：watch sessionStore.list，added → ensureStreamSubscription，removed → disposeSession。
// 对齐派生态视野（isGenerating 扫描所有 session），消除惰性订阅盲区（非交互 session 终态事件丢失 → 侧栏卡 running）。
// flush:'sync' 保证 appendSession 同 tick 建订阅（fork-ask 路径 send 前订阅就绪）。onScopeDispose 随 App 卸载退订。
bindSessionStreamSync()
// compact-queued-messages：初始化 useCompactQueue 单例。App setup 是全局 effect 作用域，
// 首次调用绑定 app 级 scope（onScopeDispose 随 App 卸载触发，registerSessionCleanup 常驻，
// 防模块级 onScopeDispose 警告与过早反注册）。
useCompactQueue()
onMounted(() => { void init() })
// [W8] onConnected 内部用模块级 hasConnectedBefore 区分首次 vs 重连：
// - 首次 connected → initApp（内部含 workspaceStore.load + presetCwd）
// - 重连 connected → initApp 因 appBootstrapped 守卫直接 return，records 停留在断连前 stale 数据
//   （runtime 可能重启后从磁盘重载了新记录，如另一窗口写入），故额外 fire-and-forget load() 刷新。
//   hasConnectedBefore 与 appBootstrapped 同为模块级，组件卸载重挂（非模块重载）时保留值，
//   避免新实例误判为「首次」再调 initApp（被守卫吞）导致 load 不刷新。
watch(connectionState, (s) => {
  if (s === 'connected') {
    void onConnected()
    // 兜底：连接后主动拉一次 models（对齐 refreshProviders 范式，防订阅时序竞态未来回归）。
    // mock 模式 WS 不回 model.list reply（mockSend 仅 ping/pong）→ pending 65s 超时，跳过避免 boot 卡顿。
    if (import.meta.env.VITE_MOCK !== 'true') void refreshModels()
  }
})

/** 用户点击「重试」：委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
 *  重启成功后 supervisor 广播 runtime-port，onRuntimePort 监听自动重连 → 回到 connected。 */
function onRetry(): void {
  void retryRuntime()
}

onBeforeUnmount(() => {
  teardown()
  // settings 订阅随 App 卸载销毁（HMR/测试场景）。不断在 AppShell unmount（断连）时销毁——
  // 订阅跨断重连常驻（global handler 存于模块级 Map，重连后 dispatcher 复用，无需重注册）。
  disposeSettings()
})
</script>

