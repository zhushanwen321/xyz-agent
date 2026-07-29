<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
/**
 * Landing.vue —— 新建任务落地空态（#2，spec §3.1 / §4.5）。
 *
 * 渲染条件由 Panel 控制（messageCount===0 && !isGenerating）。本组件是 presentational：
 * 接 props（cwd/branch/error 态）+ emit 动作（open-dir/open-branch/retry），不直接耦合状态机。
 * Panel（容器）把 emit 接到 useNewTaskFlow / useSidebar.retryHistory。
 *
 * UC-7 守卫（AC-2.2）：gitBranch 为空（非 git 目录）→ branch chip 隐藏。
 * NFR④#2 AC-2.6：historyError=true → 显重试按钮，不永久卡住。
 * 首次启动延迟 create（AC-1.7）：currentCwd 为空 → directory chip 显「选择目录」空态。
 */

import { useI18n } from 'vue-i18n'
import { Folder, GitFork, RefreshCw, Globe, Unplug } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import DirSelectPopover from './DirSelectPopover.vue'
import BranchSelectPopover from './BranchSelectPopover.vue'
import CreateBranchModal from './CreateBranchModal.vue'
import CreateWorktreeModal from './CreateWorktreeModal.vue'
import RemoteConnectModal from '@/components/remote/RemoteConnectModal.vue'
import PresetSelectChip from './PresetSelectChip.vue'
import Composer from '@/components/panel/Composer.vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useToast } from '@/composables/useToast'
import { dirNameOf } from '@/composables/logic/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { isRemoteMode, getActiveProfile, deactivateRemote } from '@/lib/remote/connection-config'
import { getRttStats, type RttStats } from '@/lib/ws-client'

const props = withDefaults(
  defineProps<{
    /** 绑定的 session id（首次启动延迟 create 时为 null） */
    sessionId: string | null
    /** 当前 cwd（chip 回灌；null/空 → 首次启动空态文案） */
    currentCwd?: string | null
    /** 当前分支名（空 → 非 git 目录，branch chip 隐藏，AC-2.2） */
    gitBranch?: string | null
    /** getHistory 加载失败 → 显重试按钮（AC-2.6） */
    historyError?: boolean
  }>(),
  { currentCwd: null, gitBranch: null, historyError: false },
)

const emit = defineEmits<{
  (e: 'open-dir'): void
  (e: 'open-branch'): void
  (e: 'retry'): void
}>()

const { t } = useI18n()
const flow = useNewTaskFlow()
const { error: toastError } = useToast()

/**
 * onOpenDirDialog — 打开 OS 目录选择器（AC-5.6 异常反馈）。
 *
 * flow.openDirDialog 的 IPC 招错时 toast 提示用户（不再变 unhandled rejection）。
 * 模板不能内联 flow.openDirDialog()：那样返回的 Promise 无人 catch，reject 变 unhandled rejection。
 */
function onOpenDirDialog(): void {
  flow.openDirDialog().catch((e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e)
    toastError(t('newTask.landing.dirSelectorFailed', { reason }))
  })
}
// landing 态 session 真源是 NewTaskFlow（selectWorkspace/openDirDialog create 的 session 不经
// useSidebar，panel leaf.sessionId 滞后）。优先 flow 真源，props 作 fallback（常态新建两者一致）。
// 前两者都 null（真 landing 态）时 composerSid 为 null——CommandPopover 走 skills fallback
// （settingsStore 全局 skills + projectSkills），不再依赖公共 session pi 命令（W3 已移除公共 session）。
const composerSid = computed(() => flow.currentSessionId.value ?? props.sessionId)
const cwd = computed(() => flow.currentCwd.value ?? props.currentCwd)

/**
 * 远程模式（spec §八:218-228 状态条 + §presetCwd 远程分支）。
 *
 * - isRemote 一次性求值（modal reload 后整页重建，组件重挂时重新求值；不 watch）。
 * - 读 connection-config.isRemoteMode（持久化模式）非 ws-client.getIsRemote（当前 WS 状态）——
 *   landing 渲染时 WS 可能重连中，用持久化模式避免状态条闪烁（D5）。
 */
const isRemote = isRemoteMode()
const workspaceStore = useWorkspaceStore()

/** RemoteConnectModal 开关（状态条「切换」按钮 + DirSelectPopover emit remote-connect 触发）。 */
const showRemoteModal = ref(false)

/** RTT 统计快照（getRttStats 非响应式，UI 轮询消费，wave2 设计意图）。 */
const rttStats = ref<RttStats>({ count: 0 })
/** RTT 轮询 timer（onMounted 启动 / onBeforeUnmount 清理，防内存泄漏）。 */
let rttTimer: ReturnType<typeof setInterval> | null = null

/**
 * 远程主机名（getActiveProfile url 经 new URL 取 hostname）。
 * isRemote=true 时 getActiveProfile 必非空（isRemoteMode 内部短路 mode==='remote' && getActiveProfile()!==null），
 * 仍守卫 try/catch 防 url 畸形 + profile 边界 null → 状态条 v-if=isRemote && remoteHost 兜底不渲染。
 */
const remoteHost = computed<string>(() => {
  const profile = getActiveProfile()
  if (!profile) return ''
  try {
    return new URL(profile.url).hostname || profile.url
     
  } catch {
    return profile.url
  }
})

/** RTT last 值（count=0 时无样本返 null，状态条显「-」）。 */
const rttLast = computed<number | null>(() => (rttStats.value.count > 0 ? rttStats.value.last ?? null : null))

/**
 * presetCwd 决策（远程分支 IF6）：
 * - 远程模式：records[0] 存在 → 预选 records[0].cwd；records 空 → 保持空 chip 态（不用 props.currentCwd 兑底，
 *   远程 server 的 cwd 语义不同，不能兑本地 defaultCwd）。
 * - 本地模式：逐字节不变（用 props.currentCwd）。
 */
function applyPresetCwd(): void {
  if (flow.currentCwd.value) return // 已有 cwd 不覆盖
  if (isRemote) {
    const firstRecord = workspaceStore.records[0]
    if (firstRecord) {
      flow.presetCwd(firstRecord.cwd)
    }
    // records 空保持空 chip 态（不调 presetCwd）
    return
  }
  if (props.currentCwd) {
    flow.presetCwd(props.currentCwd)
  }
}

/** 「断开」按钮：deactivateRemote + location.reload（切回本地模式，reload 后 isRemoteMode=false）。 */
function onDisconnectRemote(): void {
  deactivateRemote()
  location.reload()
}

/**
 * landing 态进入保障 + cwd 同步：
 * app 启动 / 空 session 时 Panel 因 !sessionId 渲染 Landing，但 flow.state 可能还是 idle
 * （未走 startFlow）→ presetCwd 不执行（要求 state=landing）→ cwd 未同步 → mode 恒 not-repo →
 * Git chip 不显示 + 点 chip 时 idle→branch-popover 非法转换报错。
 * startFlow 幂等（已 landing 不翻 state，只刷新 cwd），idle 态调它会 idle→landing + presetCwd。
 *
 * 远程模式：presetCwd 走 applyPresetCwd 的远程分支（records[0] 预选 / 空保持空 chip）。
 */
onMounted(() => {
  if (flow.state.value !== 'landing') {
    flow.startFlow(props.currentCwd ?? undefined)
  } else {
    applyPresetCwd()
  }
  // 远程模式启动 RTT 轮询（2s 间隔，D4；本地模式不轮询省 CPU）
  if (isRemote) {
    rttStats.value = getRttStats()
    rttTimer = setInterval(() => {
      rttStats.value = getRttStats()
    }, RTT_POLL_INTERVAL_MS)
  }
})
watch(() => props.currentCwd, () => {
  if (!flow.currentCwd.value) {
    applyPresetCwd()
  }
})
/** RTT 轮询间隔（spec §八 + D4：2s 平衡及时性与 CPU，心跳 15s 间隔下能看到最近样本）。 */
const RTT_POLL_INTERVAL_MS = 2000

onBeforeUnmount(() => {
  if (rttTimer) {
    clearInterval(rttTimer)
    rttTimer = null
  }
})
/**
 * 当前分支名（Git chip 显示）。flow.gitInfo 现已合并 landing 态数据源
 *（useNewTaskFlow 从 dirSelect.worktreeItems HEAD 项派生），无需组件层再查 worktreeItems。
 */
const branch = computed(() => flow.gitInfo.value?.branch ?? props.gitBranch ?? null)
/** 是否为 git 仓库目录（Git chip 可见性守卫，pendingCwd 驱动的 workspace.detect 三态）。 */
const isGitRepo = computed(() => flow.mode?.value !== 'not-repo')

/** directory chip 文案：有 cwd 显示目录名，否则首次启动空态（AC-1.7） */
const dirLabel = computed(() => {
  const c = cwd.value
  if (!c) return t('newTask.landing.selectDir')
  // 取末段目录名（dirNameOf 收敛到 logic/path SSOT，与 PanelHeader mono cwd 风格一致）
  return dirNameOf(c)
})

/** 时段问候语前缀（spec §3.1「上午好呀/下午好呀/晚上好呀」） */
// 时段分界：<12 上午，<18 下午，否则晚上（24h 制）
const HOUR_NOON = 12
const HOUR_EVENING = 18
const greetingPrefix = computed(() => {
  const h = new Date().getHours()
  if (h < HOUR_NOON) return t('app.greetingMorning')
  if (h < HOUR_EVENING) return t('app.greetingAfternoon')
  return t('app.greetingEvening')
})
const isDirOpen = computed({
  get: () => flow.state.value === 'dir-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openDirPopover() },
})
const isBranchOpen = computed({
  get: () => flow.state.value === 'branch-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openBranchPopover() },
})
/** preset popover 展开绑定（preset 互斥 wave）：与 dir/branch 同模式共享 flow 单实例状态机互斥 */
const isPresetOpen = computed({
  get: () => flow.state.value === 'preset-popover',
  set: (v) => { if (!v) flow.closeOverlay(); else flow.openPresetPopover() },
})
/** 创建分支 modal 渲染绑定（#7）：state===branch-modal 时挂载 CreateBranchModal（Dialog teleport 到 body） */
const isBranchModalOpen = computed(() => flow.state.value === 'branch-modal')

/**
 * 创建 worktree modal 渲染绑定（W2 wave）：state===worktree-modal 时挂载 CreateWorktreeModal。
 * BranchSelectPopover Worktree tab 点「新建 worktree…」→ flow.openCreateWorktree → state=worktree-modal。
 */
const isWorktreeModalOpen = computed(() => flow.state.value === 'worktree-modal')

/** 当前 cwd 所在 workspace 的已有 worktree 列表（BranchSelectPopover Worktree tab 数据源）。 */
const worktreeItems = computed(() => flow.worktreeItems?.value ?? [])

function onSelectWorkspace(payload: { cwd: string }): void {
  flow.selectWorkspace(payload.cwd)
}
/**
 * DirSelectPopover「远程连接」动作项（远程模式）：打开 RemoteConnectModal（standalone）。
 * 不关 overlay——popover 与 modal 独立，modal 打开后 popover 由用户 Esc/点外关闭。
 */
function onRemoteConnect(): void {
  showRemoteModal.value = true
}
function onSelectBranch(payload: { name: string }): void {
  flow.selectBranch(payload.name)
}
/**
 * worktree 创建成功（CreateWorktreeModal emit success）：
 * 选定新 worktree 的 cwd（chip 回灌）+ 关 overlay 回 landing。
 */
/**
 * worktree 创建成功 / exists 态「直接开始」（CreateWorktreeModal emit success / use-existing）：
 * 选定 worktree 的 cwd（chip 回灌）+ 关 overlay 回 landing。
 */
function onWorktreeActivated(payload: { cwd: string }): void {
  flow.selectWorkspace(payload.cwd)
  flow.closeOverlay()
}

/**
 * selectWorktree —— 选择已有 worktree，切换到该 worktree 的 cwd。
 * 语义同 selectWorkspace（记 pendingCwd + 关 popover），路径来源为 worktree item.path。
 */
function onSelectWorktree(payload: { path: string }): void {
  flow.selectWorkspace(payload.path)
  flow.closeOverlay()
}
function onRetry(): void {
  emit('retry')
}
/**
 * onPresetSelect — PresetSelectChip emit select 的接收点（B6 透传链路修复）。
 *
 * 用户在 landing 态真实点击选预设（非默认回显）→ 写 flow.pendingPreset（对齐 pendingCwd/pendingModel
 * 范式），submitFirstMessage create session 时透传 sessionApi.create。Composer.onSend 不再
 * 直接读 store.selectedPresetId（已删除第二真源），统一经 flow 单一真源。
 */
function onPresetSelect(payload: { presetId: string }): void {
  flow.setPendingPreset(payload.presetId)
}
</script>

<template>
  <div
    data-testid="new-task-landing"
    class="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-hidden p-6"
  >

    <!-- 问候语（22px / weight 650 / --fg，spec §3.1） -->
    <h1 class="z-10 text-center text-[22px] font-[650] text-neutral-fg">
      {{ greetingPrefix }}，{{ t('app.greetingPrompt') }}
    </h1>

    <!-- 远程状态条（spec §八:218-228，仅 isRemoteMode=true 渲染）：
         host + RTT last ms + 切换/断开按钮。RTT 2s 轮询刷新（D4）。 -->
    <div
      v-if="isRemote && remoteHost"
      data-testid="remote-status-bar"
      class="z-10 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[12px] text-muted"
    >
      <Globe class="size-3.5 shrink-0 text-accent" />
      <span data-testid="remote-host" class="font-mono">{{ remoteHost }}</span>
      <span aria-hidden="true" class="h-3 w-px bg-border" />
      <span data-testid="remote-rtt" class="tabular-nums">
        {{ t('connection.remoteConnect.rttLabel') }}:
        {{ rttLast !== null ? `${rttLast}ms` : '-' }}
      </span>
      <Button
        data-testid="remote-switch-btn"
        variant="ghost"
        size="sm"
        class="ml-1 h-auto gap-1 px-2 py-1 text-[11px]"
        @click="showRemoteModal = true"
      >
        {{ t('connection.remoteConnect.switchBtn') }}
      </Button>
      <Button
        data-testid="remote-disconnect-btn"
        variant="ghost"
        size="sm"
        class="h-auto gap-1 px-2 py-1 text-[11px] text-danger hover:text-danger"
        @click="onDisconnectRemote"
      >
        <Unplug class="size-3" />
        {{ t('connection.remoteConnect.disconnectBtn') }}
      </Button>
    </div>

    <!-- getHistory 失败重试出口（AC-2.6，不永久卡住） -->
    <Button
      v-if="historyError"
      data-testid="retry-history"
      variant="secondary"
      class="z-10 h-auto gap-1.5 px-3 py-1.5 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
      @click="onRetry"
    >
      <RefreshCw class="shrink-0" />
      {{ t('newTask.landing.retryHistory') }}
    </Button>

    <!-- composer 卡片（variant=landing：720px 居中，--bg-input + --border + --radius-lg）。
         spec §3.1：chip 是 composer 卡片顶部元信息行，非悬空 → 经 #meta-row slot 注入。
         landing 态 session 真源用 flow（composerSid），props 作 fallback。 -->
    <Composer variant="landing" :session-id="composerSid">
      <template #meta-row>
        <div class="flex items-center gap-2 px-2.5 pt-2.5">
          <Popover v-model:open="isDirOpen">
            <PopoverTrigger as-child>
              <Button
                data-testid="chip-directory"
                variant="ghost"
                class="h-auto gap-1.5 px-2 py-1 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
                :class="{ '!text-accent': !cwd }"
              >
                <Folder class="shrink-0" />
                <span class="font-mono">{{ dirLabel }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" :collision-padding="8" class="w-[320px] p-0">
              <DirSelectPopover
                :current-cwd="currentCwd ?? null"
                @select="onSelectWorkspace"
                @open-dir-dialog="onOpenDirDialog"
                @remote-connect="onRemoteConnect"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
          <span v-if="isGitRepo" aria-hidden="true" class="h-3.5 w-px bg-border" />
          <Popover v-if="isGitRepo" v-model:open="isBranchOpen">
            <PopoverTrigger as-child>
              <Button
                data-testid="chip-branch"
                variant="ghost"
                class="h-auto gap-1.5 px-2 py-1 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
              >
                <GitFork class="shrink-0" />
                <span class="font-mono">{{ branch || t('newTask.landing.gitRepo') }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" :collision-padding="8" class="w-[420px] p-0">
              <BranchSelectPopover
                :mode="flow.mode?.value === 'bare-workspace' ? 'bare-workspace' : 'plain-repo'"
                :cwd="cwd ?? ''"
                :current-branch="branch"
                :worktree-items="worktreeItems"
                @select="onSelectBranch"
                @open-branch-modal="flow.openBranchModal()"
                @select-worktree="onSelectWorktree"
                @create-worktree="flow.openCreateWorktree()"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
          <span aria-hidden="true" class="h-3.5 w-px bg-border" />
          <PresetSelectChip
            :session-id="composerSid"
            :launch-preset-id="flow.currentSession.value?.launchPresetId"
            v-model:preset-open="isPresetOpen"
            @select="onPresetSelect"
          />
        </div>
      </template>
    </Composer>

    <!-- 创建分支 modal（#7）：BranchSelectPopover emit open-branch-modal → openBranchModal → state=branch-modal → 渲染。modal 内 Esc/提交失败留 modal（D-7）。 -->
    <CreateBranchModal v-if="isBranchModalOpen" />

    <!-- 创建 worktree modal（W2 wave）：BranchSelectPopover emit create-worktree → openCreateWorktree →
         state=worktree-modal → 渲染。modal 内五态自管，success/use-existing → selectWorkspace + closeOverlay。 -->
    <CreateWorktreeModal
      v-if="isWorktreeModalOpen"
      @close="flow.closeOverlay()"
      @success="onWorktreeActivated"
      @use-existing="onWorktreeActivated"
    />

    <!-- 远程连接配置 modal（spec §七，远程状态条「切换」按钮 / DirSelectPopover「远程连接」动作项触发）。
         standalone 模式，@close 摘除。W1 组件复用，含粘贴/手填/已保存三 tab。 -->
    <RemoteConnectModal
      v-if="showRemoteModal"
      standalone
      @close="showRemoteModal = false"
    />
  </div>
</template>
