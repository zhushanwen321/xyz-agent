<!--
  展示组件 · defer 队列 pending 气泡（session-occupancy u4b / D4 入队即显）。
  对话流尾部的用户气泡占位：半透明（opacity-55）+ Clock icon + hover 标注当前占用类型
  （[D1] 按 occupancy 三维分档：compacting →「等待上下文压缩完成后发送」/ bash →「等待
  命令执行结束后发送」/ turn 忙 →「等待当前回合结束后发送」/ 其他含投影缺失 → 泛化
  「占用结束后发送」；取数模式对齐同目录 ActivityStrip——chat store sessionPhase 投影）。
  hover 出 × 撤销——仅未提交条目（mode undefined）可撤；已提交条目（mode 已写，
  已进 pi 队列）无法从 pi 侧撤回，× 禁用 + tooltip「已提交，等待投递」（D4 撤销边界；
  disabled button 不派发 mouse 事件，tooltip 挂外层 span 承载）。
  投递确认（core message_end(user) ① → useCompactQueue.confirmDelivery）后条目出队，
  本气泡随分区响应式消失，正常气泡由 appendUser 插入对话流（转态，live ≡ reload）。
  队列条目数据纯 props（QueueBubble 同范式：队列状态持于 useCompactQueue 分区）；
  occupancy 是 session 级环境投影（与条目正交的第三信息源），经 store 直读不持本地状态。
  视觉对齐 UserBubble 气泡基线（hairline border / bubble-bg / 纯灰 tokens，无 emoji）。
-->
<template>
  <div
    class="group/pending flex flex-col items-end gap-0.5 py-0.5"
    :data-testid="`pending-bubble-${entry.id}`"
  >
    <div
      class="flex min-w-0 max-w-[85%] items-start gap-1.5 rounded-[14px_14px_4px_14px] border border-border-strong bg-[var(--bubble-bg)] px-[13px] py-[9px] opacity-55"
      :title="pendingHint"
      data-testid="pending-bubble-body"
    >
      <Clock class="mt-[3px] size-3.5 shrink-0 text-neutral-mid" aria-hidden="true" />
      <span class="min-w-0 break-words text-[length:var(--text-base)] leading-[1.55] text-neutral-fg">{{ entry.text }}</span>
      <!-- [defer segments 化] chip 计数徽标：segments 中非 text 段（image/skill/file 等）>0
           时在文本旁显示 +N——入队富内容的可见性（不丢段的可感知面）。 -->
      <span
        v-if="chipCount > 0"
        class="ml-auto shrink-0 self-center rounded-[var(--radius-sm)] bg-surface-hover px-1 py-px text-[length:var(--text-xs)] leading-[1.4] text-neutral-dim"
        :title="t('panel.deferQueue.chipBadgeHint', { count: chipCount })"
        :data-testid="`pending-bubble-chips-${entry.id}`"
      >{{ t('panel.deferQueue.chipBadge', { count: chipCount }) }}</span>
    </div>
    <span
      class="opacity-0 transition-opacity duration-150 group-focus-within/pending:opacity-100 group-hover/pending:opacity-100"
      :title="entry.mode !== undefined ? t('panel.deferQueue.submittedAwaitingDelivery') : t('panel.deferQueue.cancelQueued')"
      data-testid="pending-bubble-cancel-anchor"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-danger"
        :disabled="entry.mode !== undefined"
        :data-testid="`pending-bubble-cancel-${entry.id}`"
        @click="emit('remove', entry.id)"
      >
        <X class="size-3" />
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'

const props = defineProps<{
  entry: QueuedMessage
  /** session id（[D1] occupancy 投影查询键——hover 文案按占用类型分档；缺省回落泛化文案） */
  sessionId?: string
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()

const { t } = useI18n()
const chat = useChatStore()

/** 非 text 段数（image/skill/file chip 等）——富内容徽标计数（0 = 纯文本不显示） */
const chipCount = computed(() => props.entry.segments.filter((s) => s.type !== 'text').length)

/** [D1] hover 文案：按 occupancy 三维分档标注「等什么结束」（小时级 bash 场景的可操作
 *  信息——泛化「占用结束后发送」让用户无从得知消息被什么挡住）。优先级 compacting >
 *  bash > turn（对齐 ActivityStrip 行序）；无 sessionId / 投影缺失（getOccupancy 缺省
 *  全 idle）落泛化文案。 */
const pendingHint = computed(() => {
  if (!props.sessionId) return t('panel.deferQueue.pendingHint')
  const phase = chat.sessionPhase(props.sessionId)
  if (phase.compacting) return t('panel.deferQueue.pendingHintCompacting')
  if (phase.bash) return t('panel.deferQueue.pendingHintBash')
  if (phase.turn !== 'idle') return t('panel.deferQueue.pendingHintSettling')
  return t('panel.deferQueue.pendingHint')
})
</script>
