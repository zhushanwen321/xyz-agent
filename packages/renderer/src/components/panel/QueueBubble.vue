<!--
  展示组件 · queue_update 待发送队列（draft-composer-states S8）。
  Composer 上方独立行：accent 边框 + 蓝点脉冲 + 双队列分栏。
  两队列分色（draft §pending-bubble 同族）：
    - STEERING（accent 蓝）：追加引导当前回合，先生效（FIFO）
    - FOLLOWUP（info 青）：回合结束后开新轮排队，后生效（FIFO）

  形态：单条时直接展开（head + 1 条 item）；多条时默认折叠显 head（摘要 + 计数），
  点 head 切换展开/折叠。展开时双组分栏逐条列表，每组带序号（FIFO 顺序）。

  纯展示 + 只读：props.state 由 Composer 从 chatStore.getQueueState(sessionId) 计算传入。
  入队后不可改/不可撤（pi 无 clear_queue RPC，dequeue 按钮会是假按钮——draft S8 裁决）。
  生命周期绑定 store：message_start 到达 → store queueStates.delete → state=undefined → 本组件 v-if 消失。
-->
<template>
  <div
    v-if="state && hasAny"
    class="mb-1.5 overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)] text-[12px]"
  >
    <!-- head：脉冲点 + 标签 + 计数摘要 + chevron（多条可折叠） -->
    <Button
      variant="ghost"
      class="flex h-auto w-full items-center gap-2 rounded-none px-3 py-1.5 text-left font-normal hover:bg-[color-mix(in_oklch,var(--accent)_8%,transparent)] disabled:opacity-100"
      :class="!canToggle ? 'cursor-default' : ''"
      :disabled="!canToggle"
      :aria-expanded="canToggle ? expanded : undefined"
      :title="canToggle ? (expanded ? t('panel.queue.collapseQueue') : t('panel.queue.expandQueue')) : undefined"
      @click="toggle"
    >
      <span class="size-[7px] shrink-0 animate-pulse-accent rounded-full bg-accent" />
      <span class="shrink-0 font-mono text-[10px] font-semibold tracking-wider text-accent">{{ t('panel.queue.pending') }}</span>
      <span class="min-w-0 flex-1 truncate text-muted">
        <template v-if="totalCount > 1">{{ totalCount }} 条 · </template>{{ summary }}
      </span>
      <ChevronRight
        v-if="canToggle"
        class="size-[11px] shrink-0 text-subtle transition-transform duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="expanded ? 'rotate-90' : ''"
      />
    </Button>

    <!-- 单条且未展开：直接在 head 下方显示该条（紧凑，无需折叠） -->
    <div
      v-if="!expanded && singleGroup"
      class="border-t border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3 py-1.5"
    >
      <span
        class="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-wider"
        :class="singleGroup.key === 'followUp' ? 'text-info' : 'text-accent'"
      >
        <span
          class="size-[6px] animate-pulse-accent rounded-full"
          :class="singleGroup.key === 'followUp' ? 'bg-info' : 'bg-accent'"
        />
        {{ singleGroup.key === 'followUp' ? t('panel.queue.followupLabel') : t('panel.queue.steerLabel') }}
      </span>
      <p class="mt-0.5 text-fg">{{ singleGroup.items[0] }}</p>
    </div>

    <!-- 展开态：双组分栏逐条列表（多条折叠态点 head 展开后显示） -->
    <template v-if="expanded && totalCount > 1">
      <div
        v-for="group in groups"
        :key="group.key"
        class="border-t border-[color-mix(in_oklch,var(--accent)_18%,transparent)]"
      >
        <div class="flex items-center gap-2 px-3 pt-1.5">
          <span
            class="font-mono text-[10px] font-semibold tracking-wider"
            :class="group.key === 'followUp' ? 'text-info' : 'text-accent'"
          >{{ group.key === 'followUp' ? 'FOLLOWUP' : 'STEERING' }}</span>
          <span class="text-[10px] text-subtle">
            {{ group.key === 'followUp' ? t('panel.queue.followupFirst') : t('panel.queue.steerFirst') }}
          </span>
        </div>
        <div
          v-for="(item, i) in group.items"
          :key="`${group.key}-${i}`"
          class="flex items-start gap-2 px-3 py-1 text-fg"
        >
          <span class="shrink-0 font-mono text-[10px] text-subtle">{{ i + 1 }}</span>
          <span class="min-w-0 flex-1 break-words">{{ item }}</span>
        </div>
      </div>
      <div class="border-t border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3 py-1 text-[10px] text-subtle">
        {{ t('panel.queue.effectOrder') }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { QueueState } from '@/stores/chat'

const { t } = useI18n()

const props = defineProps<{
  state: QueueState | undefined
}>()

interface QueueGroup {
  key: 'steering' | 'followUp'
  items: string[]
}

/** 非空分组（steering 优先于 followUp，对齐 pi 队列消费顺序） */
const groups = computed<QueueGroup[]>(() => {
  const s = props.state
  if (!s) return []
  const list: QueueGroup[] = []
  if (s.steering?.length) list.push({ key: 'steering', items: s.steering })
  if (s.followUp?.length) list.push({ key: 'followUp', items: s.followUp })
  return list
})

const hasAny = computed(() => groups.value.length > 0)
const totalCount = computed(() =>
  groups.value.reduce((sum, g) => sum + g.items.length, 0),
)

/** 单条时对应的分组（单条直接展开用） */
const singleGroup = computed(() => (totalCount.value === 1 ? groups.value[0] : null))

/** 多条才可折叠切换；单条恒展开（head + 该条） */
const canToggle = computed(() => totalCount.value > 1)
const expanded = ref(false)

/** state 变化（新队列/队列清空重建）时重置折叠态 */
watch(
  () => props.state,
  () => {
    expanded.value = false
  },
)

function toggle(): void {
  if (canToggle.value) expanded.value = !expanded.value
}

/** head 摘要：steering N · followUp M（对齐 draft S8 head 计数格式） */
const summary = computed(() => {
  const parts: string[] = []
  const s = props.state
  if (s?.steering?.length) parts.push(`steering ${s.steering.length}`)
  if (s?.followUp?.length) parts.push(`followUp ${s.followUp.length}`)
  return parts.join(' · ')
})
</script>
