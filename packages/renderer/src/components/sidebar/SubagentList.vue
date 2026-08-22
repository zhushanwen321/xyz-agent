<template>
  <!--
    展示组件 · subagent 列表（Agents tab）。
    渲染 SubagentRecord[] 卡片：状态点 + agent 名称 + task 摘要 + turns/tokens/elapsed。
    点击卡片 → emit('select', subagentId)，由父组件切换 Panel sessionId。
    空态展示提示文案。
  -->
  <div class="flex h-full min-h-0 flex-col" data-testid="subagent-list">
    <!-- 加载态（M1：loadSubagents 在途） -->
    <div
      v-if="isLoading"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-loading"
    >
      <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[11px] text-neutral-dim opacity-60">{{ t('sidebar.subagentList.loading') }}</p>
    </div>
    <!-- 错误态（M1：loadSubagents 失败，可重试） -->
    <div
      v-else-if="loadError"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[11px] text-neutral-mid">{{ t('sidebar.subagentList.loadFailed', { error: loadError }) }}</p>
      <Button variant="ghost" class="h-6 text-[11px] text-accent" data-testid="subagent-list-retry" @click="emit('retry')">{{ t('sidebar.subagentList.retry') }}</Button>
    </div>
    <!-- 列表 -->
    <ScrollArea v-else-if="subagents.length > 0" class="min-h-0 flex-1">
      <div class="flex flex-col px-1.5">
        <div
          v-for="record in subagents"
          :key="record.subagentId"
          class="group relative cursor-pointer rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
          data-testid="subagent-card"
          :title="record.slug ? record.agent + ' · ' + record.slug : record.agent"
          @click="emit('select', record.subagentId)"
          @mouseleave="cancellingId = null"
        >
          <!-- 状态指示 -->
          <div class="flex items-center gap-2">
            <Loader2
              v-if="isStreaming(record)"
              class="size-[13px] shrink-0 animate-spin text-accent"
              data-testid="subagent-card-spinner"
            />
            <span
              v-else
              class="size-2 shrink-0 rounded-full"
              :class="statusDotClass(record)"
            />
            <span class="min-w-0 flex-1 truncate text-[12px] font-medium leading-[1.35] text-neutral-fg">
              {{ record.agent }}
            </span>
            <!-- slug 短标签（与 WorkflowList 第一行对齐：名称右侧 mono 小字；旧 session 兜底空串不渲染） -->
            <span
              v-if="record.slug"
              class="shrink-0 font-mono text-[10px] text-neutral-mid"
              data-testid="subagent-card-slug"
            >
              {{ record.slug }}
            </span>
            <!-- cancel 按钮（streaming 态显示，inline 两段式确认；waiting/done 投影无进程可取消，不显示） -->
            <Button
              v-if="isStreaming(record)"
              variant="ghost"
              size="icon"
              :data-testid="cancellingId === record.subagentId ? 'subagent-action-cancel-confirm' : 'subagent-action-cancel'"
              :class="cancellingId === record.subagentId
                ? 'size-5 rounded-sm border border-danger bg-danger text-neutral-fg'
                : 'size-5 text-neutral-dim hover:text-danger'"
              :title="cancellingId === record.subagentId ? t('sidebar.subagentList.cancelConfirm') : t('sidebar.subagentList.cancel')"
              @click.stop="onCancelClick(record.subagentId)"
            >
              <Check v-if="cancellingId === record.subagentId" class="size-3" />
              <X v-else class="size-3" />
            </Button>
          </div>

          <!-- 摘要 -->
          <div class="mt-1 flex items-center gap-2 pl-[21px] font-mono text-[10px] text-neutral-dim">
            <span v-if="record.turns !== undefined">{{ record.turns }} {{ t('sidebar.subagentList.turnsUnit') }}</span>
            <span v-if="record.totalTokens !== undefined">· {{ formatTokens(record.totalTokens, t('sidebar.subagentList.tokUnit')) }}</span>
            <span v-if="record.elapsedSeconds !== undefined">· {{ formatElapsed(record.elapsedSeconds) }}</span>
          </div>

          <!-- 任务描述 -->
          <div class="mt-0.5 truncate pl-[21px] text-[11px] leading-[1.3] text-neutral-mid">
            {{ record.task }}
          </div>
        </div>
      </div>
    </ScrollArea>

    <!-- 空态 -->
    <div
      v-else
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-empty"
    >
      <Bot class="size-7 text-neutral-dim opacity-40" />
      <p class="text-[11px] text-neutral-dim opacity-55">{{ t('sidebar.subagentList.empty') }}</p>
      <p class="text-[10px] text-neutral-dim opacity-40">{{ t('sidebar.subagentList.emptyHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Loader2, Bot, AlertCircle, X, Check } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SubagentRecord } from '@xyz-agent/shared'
import { deriveClosedDisplay } from '@xyz-agent/shared'

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 秒数超过此阈值显示分秒组合 */
const SECONDS_PER_MINUTE = 60

const { t } = useI18n()

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
  cancel: [subagentId: string]
  retry: []
}>()

/** 当前进入取消确认态的 subagentId（两段式：首次点击进入，再次点击执行） */
const cancellingId = ref<string | null>(null)

/** cancel 两段式：首次点击进入确认态，二次点击 emit cancel */
function onCancelClick(subagentId: string): void {
  if (cancellingId.value === subagentId) {
    emit('cancel', subagentId)
    cancellingId.value = null
  } else {
    cancellingId.value = subagentId
  }
}

/** 执行态四形态判据（residual-fixes 设计 §5.4 等价公式，权威判据）：
 *  streaming = 真在跑（进程驱动中，spinner + 取消按钮）；
 *  done = one-shot 轮终（result 有值且 chatMode 显式 false——缺省视为不可确认，
 *    落 waiting 保守兜底：无法确认不是 chat → 不宣告完成）；
 *  waiting = 兜底（chat 轮终等续聊 / 孤儿 IO 兜底 / legacy 轮终），静态圆点无取消。 */
function isStreaming(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result === undefined && record.resumable !== true
}

function isDone(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result !== undefined && record.chatMode === false
}

function isWaiting(record: SubagentRecord): boolean {
  return record.status === 'running' && !isStreaming(record) && !isDone(record)
}

/** 状态点颜色映射（design-tokens 语义色）。
 *  v4 两态：closed 是统一终态，成功/失败/取消按 closedReason/error 经 deriveClosedDisplay
 *  派生（closed 落 default bg-accent 会丢失终态语义——成功/失败都显示 accent 点）。 */
function statusDotClass(record: SubagentRecord): string {
  if (record.status === 'running') {
    // spinner 只给 isStreaming；one-shot 轮终投影 done 用绿点、其余（等续聊/孤儿兜底）
    // 用 accent 静态点（进行中的非活跃态，区别于 done 绿/error 红/cancelled 灰）。
    if (isDone(record)) return 'bg-success'
    if (isWaiting(record)) return 'bg-accent opacity-60'
    return 'bg-accent'
  }
  switch (record.status) {
    case 'done':
      return 'bg-success'
    case 'failed':
    case 'crashed':
      // crashed（子进程崩溃）与 failed 同为异常终态，共用 danger 色。
      // running 走 spinner 不会到这里，故 crashed 用 bg-danger 不会与 running 混淆。
      return 'bg-danger'
    case 'cancelled':
      return 'bg-neutral-dim opacity-50'
    case 'closed':
      // v4 B-1 统一终态：cancelled→中性；gc 失败（error 有值）→红；自然完成/级联关闭→绿
      switch (deriveClosedDisplay(record)) {
        case 'cancelled':
          return 'bg-neutral-dim opacity-50'
        case 'failed':
          return 'bg-danger'
        default:
          return 'bg-success'
      }
    default:
      // running 走 spinner 不会到这里；保留 accent 兜底防未知值无色
      return 'bg-accent'
  }
}

/** 格式化 token 数（超过阈值显示 k） */
function formatTokens(tokens: number, unit: string): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${unit}`
  return `${tokens} ${unit}`
}

/** 格式化耗时（秒 → 可读） */
function formatElapsed(seconds: number): string {
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  return `${seconds}s`
}
</script>
