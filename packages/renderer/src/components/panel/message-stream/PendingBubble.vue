<!--
  展示组件 · defer 队列 pending 气泡（session-occupancy u4b / D4 入队即显）。
  对话流尾部的用户气泡占位：半透明（opacity-55）+ Clock icon + hover 标注「压缩结束后
  发送」。hover 出 × 撤销——仅未提交条目（mode undefined）可撤；已提交条目（mode 已写，
  已进 pi 队列）无法从 pi 侧撤回，× 禁用 + tooltip「已提交，等待投递」（D4 撤销边界；
  disabled button 不派发 mouse 事件，tooltip 挂外层 span 承载）。
  投递确认（core message_end(user) ① → useCompactQueue.confirmDelivery）后条目出队，
  本气泡随分区响应式消失，正常气泡由 appendUser 插入对话流（转态，live ≡ reload）。
  纯展示 + remove emit（QueueBubble 同范式）：队列状态持于
  useCompactQueue 分区，本组件不取数不持状态。视觉对齐 UserBubble 气泡基线
  （hairline border / bubble-bg / 纯灰 tokens，无 emoji）。
-->
<template>
  <div
    class="group/pending flex flex-col items-end gap-0.5 py-0.5"
    :data-testid="`pending-bubble-${entry.id}`"
  >
    <div
      class="flex min-w-0 max-w-[85%] items-start gap-1.5 rounded-[14px_14px_4px_14px] border border-border-strong bg-[var(--bubble-bg)] px-[13px] py-[9px] opacity-55"
      :title="t('panel.deferQueue.pendingHint')"
      data-testid="pending-bubble-body"
    >
      <Clock class="mt-[3px] size-3.5 shrink-0 text-neutral-mid" aria-hidden="true" />
      <span class="min-w-0 break-words text-[length:var(--text-base)] leading-[1.55] text-neutral-fg">{{ entry.text }}</span>
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
import { useI18n } from 'vue-i18n'
import { Clock, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'

defineProps<{
  entry: QueuedMessage
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()

const { t } = useI18n()
</script>
