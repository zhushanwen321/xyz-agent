<!--
  展示组件 · compact 待发队列 badge（compact-queued-messages W2）。
  Composer 上方独立行（QueueBubble 旁）：压缩执行期间用户消息的暂存队列预览。

  形态：accent 边框 + 蓝点脉冲 + 标签 + 条数 + 首条截断预览；下方展开逐条列表，
  每条带 × 取消按钮（用户可撤回误排队消息）。队列空时整体 v-if 消失
  （flush 成功 / 逐条取消后自动隐藏，无需外部显隐控制）。

  纯展示 + remove 回调（对齐 QueueBubble 纯展示范式）：不持状态——count/peek
  从 useCompactQueue() 单例 computed 读取，updateFor 内读 messages.length 建立
  reactive 依赖（入队/取消实时反映到 UI，跨组件共享同一队列实例）。

  [M4 queue 子域] 数据源唯一：useCompactQueue 模块级单例（含 flush 编排，shell 层），
  与 QueueBubble（pi queueStates 快照，经 chatStore）语义互补、消费点各自唯一。
-->
<template>
  <div
    v-if="count > 0"
    class="mb-1.5 overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-accent-soft text-[length:var(--text-xs)]"
    data-testid="compact-queue-badge"
  >
    <!-- head：脉冲点 + 标签 + 条数 + 首条预览（truncate） -->
    <div class="flex items-center gap-2 px-3 py-1.5">
      <span class="size-[7px] shrink-0 animate-pulse-accent rounded-full bg-accent" />
      <span class="shrink-0 font-mono text-[length:var(--text-3xs)] font-semibold tracking-wider text-accent">{{ t('panel.compactQueue.pending') }}</span>
      <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ t('panel.compactQueue.itemCount', { count }) }}</span>
      <span class="min-w-0 flex-1 truncate text-neutral-mid">{{ preview }}</span>
    </div>

    <!-- 展开列表：逐条 + × 取消 -->
    <div class="border-t border-[color-mix(in_oklch,var(--accent)_18%,transparent)]">
      <div
        v-for="item in messages"
        :key="item.id"
        class="flex items-start gap-2 px-3 py-1 text-neutral-fg"
      >
        <span class="min-w-0 flex-1 break-words">{{ item.text }}</span>
        <Button
          variant="ghost"
          size="icon"
          class="size-4 shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
          :title="t('panel.compactQueue.cancel')"
          :data-testid="`compact-queue-cancel-${item.id}`"
          @click="onCancel(item.id)"
        >
          <X class="size-3" />
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'

const props = defineProps<{
  sessionId: string | null
}>()

const { t } = useI18n()
const queue = useCompactQueue()

/** 分区消息数（computed 内 updateFor 读 messages.length，reactive 依赖在分区数组上建立） */
const count = computed(() => (props.sessionId ? queue.count(props.sessionId) : 0))
/** 只读快照（逐条列表） */
const messages = computed<QueuedMessage[]>(() => (props.sessionId ? queue.peek(props.sessionId) : []))
/** 首条预览（head truncate） */
const preview = computed(() => messages.value[0]?.text ?? '')

/** 取消单条排队（未知 id no-op，useCompactQueue.remove 契约） */
function onCancel(id: string): void {
  if (props.sessionId) queue.remove(props.sessionId, id)
}
</script>
