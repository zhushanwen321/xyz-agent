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
      <!-- runtime 重启用尽 / 远程失败（按 failReason × isRemote 分化文案与按钮） -->
      <template v-else-if="connectionState === 'failed'">
        <!-- 远程 auth 失败：token 错误或被重置 → 重新连接 + 修改连接信息 -->
        <template v-if="failReason === 'auth'">
          <AlertCircle class="size-5 text-danger" />
          <span class="text-[12.5px] text-muted">{{ t('connection.failedAuth') }}</span>
          <div class="flex gap-2">
            <Button variant="default" size="sm" data-testid="failed-reconnect-btn" @click="onRetry">
              {{ t('connection.retry') }}
            </Button>
            <Button variant="ghost" size="sm" data-testid="failed-edit-connection-btn" @click="onEditConnection">
              {{ t('connection.editConnection') }}
            </Button>
          </div>
        </template>
        <!-- 远程被挤下线：此设备已在其他窗口连接 → 强制接管（断开重连挤回对方） -->
        <template v-else-if="failReason === 'replaced'">
          <AlertCircle class="size-5 text-danger" />
          <span class="text-[12.5px] text-muted">{{ t('connection.failedReplaced') }}</span>
          <Button variant="default" size="sm" data-testid="failed-force-takeover-btn" @click="onRetry">
            {{ t('connection.forceTakeover') }}
          </Button>
        </template>
        <!-- 远程网络失败：检查 Tailscale/服务器是否在线 → 重试（断开重连，非 IPC restart） -->
        <template v-else-if="isRemote">
          <AlertCircle class="size-5 text-danger" />
          <span class="text-[12.5px] text-muted">{{ t('connection.failedRemoteNetwork') }}</span>
          <Button variant="default" size="sm" data-testid="failed-remote-retry-btn" @click="onRetry">
            {{ t('connection.retry') }}
          </Button>
        </template>
        <!-- 本地失败（failReason=null 或 network+!isRemote）：现状分支逐字节不变 -->
        <template v-else>
          <AlertCircle class="size-5 text-danger" />
          <span class="text-[12.5px] text-muted">{{ t('connection.failed') }}</span>
          <Button variant="default" size="sm" data-testid="runtime-retry-btn" @click="onRetry">
            {{ t('connection.retry') }}
          </Button>
        </template>
      </template>
      <!-- 默认连接中（connecting/disconnected/reconnecting） -->
      <span v-else class="text-[12.5px] text-neutral-dim">{{ t('connection.connecting') }}</span>
    </div>
  </div>
  <template v-else>
    <!-- L0 Shell 挂载点。traffic light 安全区在 AsideRegion 内（padding-top:52px，spec §三）。 -->
    <AppShell />
  </template>
  <!-- 远程连接配置 modal（failed(auth) 分支点 [修改连接信息] 触发打开；T4 stub 占位） -->
  <RemoteConnectModal v-if="showRemoteModal" standalone @close="showRemoteModal = false" />
  <ToastContainer />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import AppShell from '@/components/shell/AppShell.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { Button } from '@/components/ui/button'
import RemoteConnectModal from '@/components/remote/RemoteConnectModal.vue'
import { useConnection } from '@/composables/useConnection'
import { useSidebar } from '@/composables/features/useSidebar'
import { bindForkNoticeEffect } from '@/composables/effects/useForkNoticeEffect'
import { bindPendingRequestsBatchEffect } from '@/composables/effects/usePendingRequestsBatchEffect'
import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import { bindSessionStreamSync } from '@/composables/effects/useSessionStreamSync'
// ws-client 单例只读 ref：failReason/isRemote 远程化扩展（wave1 ae71e6540）。
// App 直接读 ws-client 模块而非 useConnection 返回值——useConnection 不暴露这俩 ref，
// 且 App-w8 测试 mock useConnection 不影响此处模块 import（解耦测试契约）。
import { getFailReason, getIsRemote } from '@/lib/ws-client'

// 应用挂载即初始化连接（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
const { t } = useI18n()
const { state: connectionState, init, teardown, retryRuntime } = useConnection()
// failed 分支按 (failReason, isRemote) 分化文案+按钮（远程 auth/replaced/network 三态 + 本地不变）。
const failReason = getFailReason()
const isRemote = getIsRemote()
// 启动编排（#1/#3）：连接建立后自动进 new-task landing（首次）或恢复最近 session。
// useConnection.init 是 fire-and-forget（connect 异步），return 时连接未握手指；state==='connected'
// 是「连接成功」唯一可靠信号——watch 它触发 onConnected，appBootstrapped 守卫保证 HMR/重连幂等。
const { onConnected } = useSidebar()
// RV1+RV2：fork 反馈行 + 后台分支通知全局订阅（session.forkNotice 广播 → transient feed；
// useForkBranchNotify diff 分支状态 → 状态变化反馈行）。App setup 是全局 effect 作用域，
// onScopeDispose 随 App 卸载退订（单实例，与 events.onGlobalType 范式一致）。
bindForkNoticeEffect()
// P3 D3：审批唤醒批量补发全局订阅（extension.pendingRequestsBatch，sendInitialState 第 14 段）。
// 冷启动/长断线/页面 reload 时服务端主动推送跨 session 聚合的 pending UI 请求，唤醒审批挂起状态。
// setup 同步注册（早于 onMounted 的 init() 异步连接），确保 WS initial state 到达时 handler 已就绪。
bindPendingRequestsBatchEffect()
// fast-handoff：订阅 session.handoffComplete 广播 → 复位源 session handingOff 态 + 刷新列表 + 跳转新 session。
// 与 bindForkNoticeEffect 同范式（effect 层订阅，非 useChat switch）。onScopeDispose 随 App 卸载退订。
bindHandoffEffect()
// session 全量事件订阅编排：watch sessionStore.list，added → ensureStreamSubscription，removed → disposeSession。
// 对齐派生态视野（isGenerating 扫描所有 session），消除惰性订阅盲区（非交互 session 终态事件丢失 → 侧栏卡 running）。
// flush:'sync' 保证 appendSession 同 tick 建订阅（fork-ask 路径 send 前订阅就绪）。onScopeDispose 随 App 卸载退订。
bindSessionStreamSync()
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

/** 远程连接配置 modal 开关（failed(auth) 分支点 [修改连接信息] 触发）。
 *  RemoteConnectModal 是 T4 stub（占位），本 wave 仅接线挂载点。 */
const showRemoteModal = ref(false)

/** 用户点击「重试」/「重新连接」/「强制接管」：委托 retryRuntime。
 *  useConnection.retryRuntime 已分模式（wave1 c52820b1e）：
 *  - 远程：disconnect + connect(activeProfile, {auth})（断开重连，非 IPC restart）
 *  - 本地：IPC runtime-restart → 主进程 supervisor.restartRuntime（逐字节不变） */
function onRetry(): void {
  void retryRuntime()
}

/** 用户点击「修改连接信息」：打开 RemoteConnectModal（T4 stub）编辑远程 profile。 */
function onEditConnection(): void {
  showRemoteModal.value = true
}

onBeforeUnmount(() => teardown())
</script>
