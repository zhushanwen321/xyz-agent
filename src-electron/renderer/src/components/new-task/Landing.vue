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
import { Folder, GitBranch, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'

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

/** directory chip 文案：有 cwd 显示目录名，否则首次启动空态（AC-1.7） */
const dirLabel = computed(() => {
  const cwd = props.currentCwd
  if (!cwd) return '选择目录'
  // 取末段目录名（与 PanelHeader mono cwd 风格一致）
  const seg = cwd.split('/').filter(Boolean).pop()
  return seg ?? cwd
})

/** 时段问候语前缀（spec §3.1「上午好呀/下午好呀/晚上好呀」） */
// 时段分界：<12 上午，<18 下午，否则晚上（24h 制）
const HOUR_NOON = 12
const HOUR_EVENING = 18
const greetingPrefix = computed(() => {
  const h = new Date().getHours()
  if (h < HOUR_NOON) return '上午好呀'
  if (h < HOUR_EVENING) return '下午好呀'
  return '晚上好呀'
})

function onDir(): void {
  emit('open-dir')
}
function onBranch(): void {
  emit('open-branch')
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
    <!-- watermark：zcode 描边，opacity 0.04 背景层（spec §3.1） -->
    <svg
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 m-auto h-1/2 w-1/2 text-fg opacity-[0.04]"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <rect x="20" y="20" width="60" height="60" rx="10" />
      <path d="M35 50 L45 60 L65 40" stroke-linecap="round" stroke-linejoin="round" />
    </svg>

    <!-- 问候语（22px / weight 650 / --fg，spec §3.1） -->
    <h1 class="z-10 text-center text-[22px] font-[650] text-fg">
      {{ greetingPrefix }}，有什么想让我帮忙的吗
    </h1>

    <!-- composer 顶部元信息行：directory chip（左）+ branch chip（右，UC-7 守卫） -->
    <div class="z-10 flex items-center gap-2 rounded-[var(--radius-lg)] border border-border bg-bg-input px-2 py-1.5">
      <Button
        data-testid="chip-directory"
        variant="ghost"
        class="h-auto gap-1.5 px-2 py-1 text-[12.5px] text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
        :class="{ '!text-accent': !currentCwd }"
        @click="onDir"
      >
        <Folder class="shrink-0" />
        <span class="font-mono">{{ dirLabel }}</span>
      </Button>
      <span v-if="gitBranch" aria-hidden="true" class="h-3.5 w-px bg-border" />
      <Button
        v-if="gitBranch"
        data-testid="chip-branch"
        variant="ghost"
        class="h-auto gap-1.5 px-2 py-1 text-[12.5px] text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
        @click="onBranch"
      >
        <GitBranch class="shrink-0" />
        <span class="font-mono">{{ gitBranch }}</span>
      </Button>
    </div>

    <!-- getHistory 失败重试出口（AC-2.6，不永久卡住） -->
    <Button
      v-if="historyError"
      data-testid="retry-history"
      variant="secondary"
      class="z-10 h-auto gap-1.5 px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
      @click="onRetry"
    >
      <RefreshCw class="shrink-0" />
      重试加载历史
    </Button>
  </div>
</template>
