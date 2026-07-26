<template>
  <!--
    编排器 · Turn（message-stream 单个回合，W4 拆分后）。
    组合 UserBubble + TurnMeta + TurnSummary 三个子组件。
    保留：rootEl（虚拟滚动测量）+ trace 区 Block 编排 + ChangeSetCard。
  -->
  <div ref="rootEl" class="flex flex-col gap-3.5 pb-5">
    <!-- user 区：UserBubble 子组件 -->
    <UserBubble
      v-if="turn.user"
      :turn="turn"
      :session-id="sessionId"
      :can-edit="canEdit"
      :is-session-editable="isSessionEditable"
      @edit-state-change="emit('edit-state-change', $event)"
    />

    <!-- assistant 区 -->
    <div class="group/ai flex flex-col gap-0 self-stretch">
      <!-- turn-meta：TurnMeta 子组件 -->
      <TurnMeta
        :turn="turn"
        :session-active="sessionActive"
        :is-streaming="isStreaming"
        :think-count="thinkCount"
        :tool-count="toolCount"
        :expanded="expanded"
        :elapsed="elapsed"
        @update:expanded="expanded = $event"
      />

      <!-- 折叠 trace：working 或 expanded 时展开 -->
      <Transition :css="false" @before-leave="onTraceBeforeLeave" @leave="onTraceLeave" @enter="onTraceEnter">
        <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
          <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
            <Block
              v-for="(blk, bIdx) in traceBlocksByAssistant[aIdx]"
              :key="`${assistant.id}-${blk.kind}-${bIdx}`"
              :type="blk.kind"
              :content="blk.kind === 'text' ? (blk.ref as string) : blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).content : undefined"
              :tool="blk.kind === 'tool' ? (blk.ref as ToolCall) : undefined"
              :collapsed="blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).collapsed : undefined"
              :working="sessionActive"
              :session-id="sessionId"
            />
          </template>
        </div>
      </Transition>

      <!-- 收尾 summary：TurnSummary 子组件 -->
      <TurnSummary
        :turn="turn"
        :session-id="sessionId"
        :is-streaming="isStreaming"
        :last-assistant="lastAssistant"
      />

      <!-- 变更集卡（W10，ADR-0024） -->
      <ChangeSetCard
        v-if="changeSetFileChanges.length > 0"
        class="mt-2"
        :file-changes="changeSetFileChanges"
        :status="changeSetStatus"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageTurn, OrderedBlock } from '@/composables/logic/messageTurns'
import { countThinking, countToolCalls, expandAssistantBlocks } from '@/composables/logic/messageTurns'
import type { ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import ChangeSetCard from './ChangeSetCard.vue'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import Block from './Block.vue'
import { useChatStore } from '@/stores/chat'
import { useTurnElapsed } from '@/composables/panel/useTurnElapsed'
import { useResizeReport } from '@/composables/effects/useResizeReport'
import { useStickGuard, useTraceTransition } from '@/composables/effects/useStickGuard'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionActive?: boolean
  }>(),
  { isSessionActive: undefined },
)

/**
 * B9：编辑状态变化通知父组件。
 */
const emit = defineEmits<{
  'edit-state-change': [{ editing: boolean }]
}>()

const chat = useChatStore()

/** 最后一条 assistant */
const lastAssistant = computed(() => {
  const as = props.turn.assistants
  return as[as.length - 1] ?? null
})

/** 虚拟滚动高度测量（W4） */
const rootEl = ref<HTMLElement | null>(null)
useResizeReport(rootEl, () => props.turn.user?.id ?? props.turn.assistants[0]?.id ?? '')

/**
 * isStreaming（turn 级）：文本正在流式生成。
 * sessionActive（session 级）：对话进行中（含 streaming/ask-user/subagent/compacting 等）。
 */
const isStreaming = computed(() => props.turn.isStreaming)
const sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

/** 对话进行中或手动 expanded 时展开 trace */
const expanded = ref(false)
const showTrace = computed(() => sessionActive.value || expanded.value)

/**
 * 工作耗时 live 计时。
 */
const { elapsed } = useTurnElapsed(
  () => props.turn.assistants,
  () => isStreaming.value,
  () => sessionActive.value,
  () => {
    expanded.value = false
  },
)

/** trace 折叠 transition hooks */
const { onTraceBeforeLeave, onTraceLeave, onTraceEnter } = useTraceTransition(useStickGuard())

/** 变更集卡（W10） */
const changeSetFileChanges = computed(() => lastAssistant.value?.fileChanges ?? [])
const changeSetStatus = computed(() => {
  const msg = lastAssistant.value
  if (!msg) return undefined
  return chat.getChangeSetStatus(props.sessionId, msg.id)
})

/** 本 session 是否可编辑 */
const isSessionEditable = computed(() => chat.isActive(props.sessionId))

/** 最后一条 assistant 的索引 */
const lastAssistantIdx = computed(() => props.turn.assistants.length - 1)

/**
 * trace 内每个 assistant 的有序块。
 * 末位 assistant 跳过 text 块（text 在底部 summary 位渲染）。
 */
const traceBlocksByAssistant = computed<OrderedBlock[][]>(() => {
  return props.turn.assistants.map((a, i) => {
    const blocks = expandAssistantBlocks(a)
    if (i === lastAssistantIdx.value) {
      return blocks.filter((b) => b.kind !== 'text')
    }
    return blocks
  })
})
</script>
