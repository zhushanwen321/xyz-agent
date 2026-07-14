<template>
  <!--
    展示组件 · workflow 列表（Flows tab 视图 1）。
    渲染 WorkflowRunRecord[] 卡片：状态点 + scriptName + slug + 进度条 + 摘要。
    点击卡片 → emit('select', runId)，由父组件进入视图 2（WorkflowDetail）。
    空态展示提示文案。
  -->
  <div class="flex min-h-0 flex-col" data-testid="workflow-list">
    <!-- 加载态（M1：loadWorkflows 在途） -->
    <div
      v-if="isLoading"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="workflow-list-loading"
    >
      <Loader2 class="size-4 animate-spin text-subtle opacity-60" />
      <p class="text-[11.5px] text-subtle opacity-60">{{ t('sidebar.workflowList.loading') }}</p>
    </div>
    <!-- 错误态（M1：loadWorkflows 失败，可重试） -->
    <div
      v-else-if="loadError"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="workflow-list-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[11.5px] text-muted">{{ t('sidebar.workflowList.loadFailed', { error: loadError }) }}</p>
      <Button variant="ghost" class="h-6 text-[11px] text-accent" data-testid="workflow-list-retry" @click="emit('retry')">{{ t('sidebar.workflowList.retry') }}</Button>
    </div>
    <!-- 列表 -->
    <div v-else-if="workflows.length > 0" class="min-h-0 flex-1 overflow-y-auto px-1.5">
      <div
        v-for="record in workflows"
        :key="record.runId"
        class="group relative cursor-pointer rounded-md px-2 py-[7px] transition-colors hover:bg-surface-hover"
        data-testid="workflow-card"
        @click="emit('select', record.runId)"
      >
        <!-- 第一行：状态指示 + scriptName + slug -->
        <div class="flex items-center gap-2">
          <Loader2
            v-if="record.status === 'running'"
            class="size-[13px] shrink-0 animate-spin text-accent"
            data-testid="workflow-card-spinner"
          />
          <span
            v-else
            class="size-2 shrink-0 rounded-full"
            :class="statusDotClass(record.status, record.reason)"
          />
          <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-[1.35] text-fg">
            {{ record.scriptName }}
          </span>
          <span v-if="record.slug" class="shrink-0 font-mono text-[10px] text-muted">
            {{ record.slug }}
          </span>
          <!-- 操作按钮：running 态 Pause+Abort，paused 态 Resume+Abort（hover 显示） -->
          <div v-if="record.status === 'running' || record.status === 'paused'" class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              class="size-5 text-subtle hover:text-fg"
              :title="record.status === 'running' ? t('sidebar.workflowList.pause') : t('sidebar.workflowList.resume')"
              :data-testid="`workflow-action-${record.status === 'running' ? 'pause' : 'resume'}`"
              @click.stop="emit('action', { action: record.status === 'running' ? 'pause' : 'resume', runId: record.runId })"
            >
              <Pause v-if="record.status === 'running'" class="size-3" />
              <Play v-else class="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="size-5 text-subtle hover:text-danger"
              :title="t('sidebar.workflowList.terminate')"
              data-testid="workflow-action-abort"
              @click.stop="emit('action', { action: 'abort', runId: record.runId })"
            >
              <Square class="size-3" />
            </Button>
          </div>
        </div>

        <!-- 第二行：进度条 + agent 完成比例 -->
        <div class="mt-1.5 flex items-center gap-2 pl-[21px]">
          <div class="h-[3px] min-w-[40px] flex-1 overflow-hidden rounded-full bg-border">
            <div
              class="h-full rounded-full transition-all"
              :class="progressBarClass(record)"
              :style="{ width: `${progressPercent(record)}%` }"
            />
          </div>
          <span class="shrink-0 font-mono text-[10px] text-subtle">
            {{ completedAgentCount(record) }}/{{ record.agentCalls.length }} agents
          </span>
        </div>

        <!-- 第三行：摘要（耗时 · token） -->
        <div class="mt-1 flex items-center gap-2 pl-[21px] font-mono text-[10px] text-subtle">
          <span v-if="record.startedAt">{{ formatElapsedFromIso(record.startedAt, record.completedAt) }}</span>
          <span v-if="record.usedTokens !== undefined">· {{ formatTokens(record.usedTokens) }}</span>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div
      v-else
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="workflow-list-empty"
    >
      <Workflow class="size-7 text-subtle opacity-40" />
      <p class="text-[11.5px] text-subtle opacity-55">{{ t('sidebar.workflowList.empty') }}</p>
      <p class="text-[10.5px] text-subtle opacity-40">{{ t('sidebar.workflowList.emptyHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Loader2, Workflow, Pause, Play, Square, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { WorkflowRunRecord, WorkflowRunStatus, WorkflowDoneReason } from '@xyz-agent/shared'

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 百分比基数 */
const PERCENT_BASE = 100
/** 毫秒 → 秒 */
const MS_PER_SECOND = 1000
/** 秒 → 分 */
const SECONDS_PER_MINUTE = 60
/** 秒 → 时 */
const SECONDS_PER_HOUR = 3600

const { t } = useI18n()

withDefaults(defineProps<{
  workflows: WorkflowRunRecord[]
  isLoading?: boolean
  loadError?: string | null
}>(), {
  isLoading: false,
  loadError: null,
})

const emit = defineEmits<{
  select: [runId: string]
  action: [payload: { action: 'pause' | 'resume' | 'abort'; runId: string }]
  retry: []
}>()

/** 状态点颜色映射（design-tokens 语义色） */
function statusDotClass(status: WorkflowRunStatus, reason?: WorkflowDoneReason): string {
  switch (status) {
    case 'done':
      return reason === 'completed' ? 'bg-success' : 'bg-danger'
    case 'paused':
      return 'bg-warning'
    default:
      return 'bg-accent'
  }
}

/** 进度条颜色（done=success，failed/aborted=danger，running=accent） */
function progressBarClass(record: WorkflowRunRecord): string {
  if (record.status === 'done') {
    return record.reason === 'completed' ? 'bg-success' : 'bg-danger'
  }
  if (record.status === 'paused') return 'bg-warning'
  return 'bg-accent'
}

/** 已完成 agent call 数量 */
function completedAgentCount(record: WorkflowRunRecord): number {
  return record.agentCalls.filter((c) => c.status === 'completed' || c.status === 'failed').length
}

/** 进度百分比 */
function progressPercent(record: WorkflowRunRecord): number {
  if (record.agentCalls.length === 0) return 0
  return Math.round((completedAgentCount(record) / record.agentCalls.length) * PERCENT_BASE)
}

/** 格式化 token 数（超过阈值显示 k） */
function formatTokens(tokens: number): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k tok`
  return `${tokens} tok`
}

/** 格式化耗时（从 ISO 时间戳算秒数） */
function formatElapsedFromIso(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const seconds = Math.floor((end - start) / MS_PER_SECOND)
  if (seconds >= SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h${Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)}m`
  }
  if (seconds >= SECONDS_PER_MINUTE) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  }
  return `${seconds}s`
}
</script>
