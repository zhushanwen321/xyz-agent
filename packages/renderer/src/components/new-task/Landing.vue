<script setup lang="ts">
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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, GitBranch, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import DirSelectPopover from './DirSelectPopover.vue'
import BranchSelectPopover from './BranchSelectPopover.vue'
import CreateBranchModal from './CreateBranchModal.vue'
import Composer from '@/components/panel/Composer.vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useToast } from '@/composables/useToast'
import { dirNameOf } from '@/composables/logic/path'

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
const branch = computed(() => flow.gitInfo.value?.branch ?? props.gitBranch ?? null)

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
/** 创建分支 modal 渲染绑定（#7）：state===branch-modal 时挂载 CreateBranchModal（Dialog teleport 到 body） */
const isBranchModalOpen = computed(() => flow.state.value === 'branch-modal')

function onSelectWorkspace(payload: { cwd: string }): void {
  flow.selectWorkspace(payload.cwd)
}
function onSelectBranch(payload: { name: string }): void {
  flow.selectBranch(payload.name)
}
function onConfirmDirtySwitch(payload: { name: string }): void {
  flow.confirmDirtySwitch(payload.name)
}
function onRetry(): void {
  emit('retry')
}
</script>

<template>
  <div
    data-testid="new-task-landing"
    class="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-hidden p-6"
  >

    <!-- 问候语（22px / weight 650 / --fg，spec §3.1） -->
    <h1 class="z-10 text-center text-[22px] font-[650] text-fg">
      {{ greetingPrefix }}，{{ t('app.greetingPrompt') }}
    </h1>

    <!-- getHistory 失败重试出口（AC-2.6，不永久卡住） -->
    <Button
      v-if="historyError"
      data-testid="retry-history"
      variant="secondary"
      class="z-10 h-auto gap-1.5 px-3 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
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
                class="h-auto gap-1.5 px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
                :class="{ '!text-accent': !cwd }"
              >
                <Folder class="shrink-0" />
                <span class="font-mono">{{ dirLabel }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" class="w-[380px] p-0">
              <DirSelectPopover
                :current-cwd="currentCwd ?? null"
                @select="onSelectWorkspace"
                @open-dir-dialog="onOpenDirDialog"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
          <span v-if="branch" aria-hidden="true" class="h-3.5 w-px bg-border" />
          <Popover v-if="branch" v-model:open="isBranchOpen">
            <PopoverTrigger as-child>
              <Button
                data-testid="chip-branch"
                variant="ghost"
                class="h-auto gap-1.5 px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
              >
                <GitBranch class="shrink-0" />
                <span class="font-mono">{{ branch }}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" class="w-[420px] p-0">
              <BranchSelectPopover
                :session-id="sessionId"
                @select="onSelectBranch"
                @confirm-dirty-switch="onConfirmDirtySwitch"
                @open-branch-modal="flow.openBranchModal()"
                @close="flow.closeOverlay()"
              />
            </PopoverContent>
          </Popover>
        </div>
      </template>
    </Composer>

    <!-- 创建分支 modal（#7）：BranchSelectPopover emit open-branch-modal → openBranchModal → state=branch-modal → 渲染。modal 内 Esc/提交失败留 modal（D-7）。 -->
    <CreateBranchModal v-if="isBranchModalOpen" />
  </div>
</template>
