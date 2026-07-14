<template>
  <!--
    展示组件 · subagent 列表（Agents tab）。
    渲染 SubagentRecord[] 卡片：状态点 + agent 名称 + task 摘要 + turns/tokens/elapsed。
    点击卡片 → emit('select', subagentId)，由父组件切换 Panel sessionId。
    空态展示提示文案。
  -->
  <div class="flex min-h-0 flex-col" data-testid="subagent-list">
    <!-- 加载态（M1：loadSubagents 在途） -->
    <div
      v-if="isLoading"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-loading"
    >
      <Loader2 class="size-4 animate-spin text-subtle opacity-60" />
      <p class="text-[11.5px] text-subtle opacity-60">{{ t('sidebar.subagentList.loading') }}</p>
    </div>
    <!-- 错误态（M1：loadSubagents 失败，可重试） -->
    <div
      v-else-if="loadError"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[11.5px] text-muted">{{ t('sidebar.subagentList.loadFailed', { error: loadError }) }}</p>
      <Button variant="ghost" class="h-6 text-[11px] text-accent" data-testid="subagent-list-retry" @click="emit('retry')">{{ t('sidebar.subagentList.retry') }}</Button>
    </div>
    <!-- 列表 -->
    <div v-else-if="subagents.length > 0" class="min-h-0 flex-1 overflow-y-auto px-1.5">
      <div
        v-for="record in subagents"
        :key="record.subagentId"
        class="group relative cursor-pointer rounded-md px-2 py-[7px] transition-colors hover:bg-surface-hover"
        data-testid="subagent-card"
        @click="emit('select', record.subagentId)"
      >
        <!-- 状态指示 -->
        <div class="flex items-center gap-2">
          <Loader2
            v-if="record.status === 'running'"
            class="size-[13px] shrink-0 animate-spin text-accent"
            data-testid="subagent-card-spinner"
          />
          <span
            v-else
            class="size-2 shrink-0 rounded-full"
            :class="statusDotClass(record.status)"
          />
          <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-[1.35] text-fg">
            {{ record.agent }}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-subtle">
            {{ record.subagentId.slice(0, SUBAGENT_ID_DISPLAY_LENGTH) }}
          </span>
        </div>

        <!-- 摘要 -->
        <div class="mt-1 flex items-center gap-2 pl-[21px] font-mono text-[10px] text-subtle">
          <span v-if="record.turns !== undefined">{{ record.turns }} turns</span>
          <span v-if="record.totalTokens !== undefined">· {{ formatTokens(record.totalTokens) }}</span>
          <span v-if="record.elapsedSeconds !== undefined">· {{ formatElapsed(record.elapsedSeconds) }}</span>
        </div>

        <!-- 任务描述 -->
        <div class="mt-0.5 truncate pl-[21px] text-[11px] leading-[1.3] text-muted">
          {{ record.task }}
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div
      v-else
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-empty"
    >
      <Bot class="size-7 text-subtle opacity-40" />
      <p class="text-[11.5px] text-subtle opacity-55">{{ t('sidebar.subagentList.empty') }}</p>
      <p class="text-[10.5px] text-subtle opacity-40">{{ t('sidebar.subagentList.emptyHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Loader2, Bot, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { SubagentRecord, SubagentStatus } from '@xyz-agent/shared'

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 秒数超过此阈值显示分秒组合 */
const SECONDS_PER_MINUTE = 60
/** subagentId 显示截断长度 */
const SUBAGENT_ID_DISPLAY_LENGTH = 12

withDefaults(defineProps<{
  subagents: SubagentRecord[]
  isLoading?: boolean
  loadError?: string | null
}>(), {
  isLoading: false,
  loadError: null,
})

const emit = defineEmits<{
  select: [subagentId: string]
  retry: []
}>()

/** 状态点颜色映射（design-tokens 语义色） */
function statusDotClass(status: SubagentStatus): string {
  switch (status) {
    case 'done':
      return 'bg-success'
    case 'failed':
      return 'bg-danger'
    case 'cancelled':
      return 'bg-subtle opacity-50'
    default:
      return 'bg-accent'
  }
}

/** 格式化 token 数（超过阈值显示 k） */
function formatTokens(tokens: number): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k tok`
  return `${tokens} tok`
}

/** 格式化耗时（秒 → 可读） */
function formatElapsed(seconds: number): string {
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  return `${seconds}s`
}
</script>
