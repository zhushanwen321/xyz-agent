<template>
  <!--
    编排器 · Turn（message-stream 单个回合，W4 拆分后）。
    组合 UserBubble + TurnMeta + TurnSummary 三个子组件。
    保留：rootEl（虚拟滚动测量）+ trace 区 Block 编排 + ChangeSetCard。
  -->
  <div ref="rootEl" class="flex flex-col gap-3.5 pb-5" :data-testid="`turn-${turn.index}`">
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
      <!-- turn-meta：TurnMeta 子组件（展开态直接读 useTurnExpansion 共享 store，无需 expanded prop） -->
      <TurnMeta
        :turn="turn"
        :session-active="sessionActive"
        :is-streaming="isStreaming"
        :think-count="thinkCount"
        :tool-count="toolCount"
        :elapsed="elapsed"
        :turn-index="turn.index"
        :session-id="sessionId"
      />

      <!-- 折叠 trace：working 或 expanded 时展开 -->
      <Transition :css="false" @before-leave="onTraceBeforeLeave" @leave="onTraceLeave" @enter="onTraceEnter">
        <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
          <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
            <template v-for="(blk, bIdx) in traceBlocksByAssistant[aIdx]" :key="`${assistant.id}-${blk.kind}-${blk.type}-${bIdx}`">
              <!-- single 块：原 Block 渲染（与改造前逻辑一致，ref 取 blk.block.ref） -->
              <Block
                v-if="blk.kind === 'single'"
                :type="blk.block.kind"
                :content="blk.block.kind === 'text' ? (blk.block.ref as string) : blk.block.kind === 'thinking' ? (blk.block.ref as ThinkingBlock).content : undefined"
                :tool="blk.block.kind === 'tool' ? (blk.block.ref as ToolCall) : undefined"
                :thinking-id="blk.block.kind === 'thinking' ? (blk.block.ref as ThinkingBlock).id : undefined"
                :collapsed="blk.block.kind === 'thinking' ? (blk.block.ref as ThinkingBlock).collapsed : undefined"
                :working="sessionActive"
                :session-id="sessionId"
              />
              <!-- merged 卡片（w2）：连续同类 thinking/tool 折叠成可展开卡，渲染逻辑下沉 MergedBlockCard。 -->
              <MergedBlockCard
                v-else
                :blk="blk"
                :working="sessionActive"
                :session-id="sessionId"
              />
            </template>
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
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { countThinking, countToolCalls, expandAssistantBlocks } from '@/composables/logic/messageTurns'
import { mergeConsecutiveBlocks, type MergedBlock } from '@/composables/logic/mergeBlocks'
import type { ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import ChangeSetCard from './ChangeSetCard.vue'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import Block from './Block.vue'
import MergedBlockCard from './MergedBlockCard.vue'
import { useChatStore } from '@/stores/chat'
import { useTurnElapsed } from '@/composables/panel/useTurnElapsed'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
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

/**
 * 折叠态接入 w1 useTurnExpansion（per-session 隔离 Map）。
 * 删除本地 expanded ref：折叠态由 composable 统一管（rail toggle / expandAll / collapseAll 共享）。
 * isExpanded 读 reactive Map 建立响应式依赖，toggle/collapse mutate 时下游失效重算。
 */
const { isExpanded, collapse } = useTurnExpansion(computed(() => props.sessionId))
/** 对话进行中（含 ask-user）或手动 expanded 时展开 trace（B 类：sessionActive 驱动） */
const showTrace = computed(() => sessionActive.value || isExpanded(props.turn.index))

/**
 * 工作耗时 live 计时。
 */
const { elapsed } = useTurnElapsed(
  () => props.turn.assistants,
  () => isStreaming.value,
  () => sessionActive.value,
  () => {
    collapse(props.turn.index)
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
 * trace 内每个 assistant 的有序块（缓存，避免 v-for 内每次 render 重算）。
 * - 末位 assistant：先 filter 掉 text 块（text 在底部 summary 位渲染，TR-w4-2：filter 在 merge 之前，
 *   避免 text 被并入 merged 组后再过滤破坏时序），再 mergeConsecutiveBlocks 折叠连续同类块。
 * - 非末位 assistant：全部块按时序（中间 text 作为过程性信息保留），同样 merge 连续 thinking/tool。
 * 消除停止时 text 从 trace(12.5px/muted) → summary(13.5px/fg) 的样式跳变。
 * streaming 时每 token 触发 re-render，computed 缓存避免对每个 assistant 重跑 expandAssistantBlocks。
 */
const traceBlocksByAssistant = computed<MergedBlock[][]>(() => {
  return props.turn.assistants.map((a, i) => {
    const blocks = expandAssistantBlocks(a)
    const filtered = i === lastAssistantIdx.value
      ? blocks.filter((b) => b.kind !== 'text')
      : blocks
    return mergeConsecutiveBlocks(filtered)
  })
})
</script>
