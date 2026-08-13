<template>
  <!--
    编排器 · Turn（message-stream 单个回合，W4 拆分后）。
    组合 UserBubble + TurnMeta + TurnSummary 三个子组件。
    保留：trace 区 Block 编排 + ChangeSetCard。
    [cw wave w3] 不再自持 root ref + 高度上报——virta 内部 RO 测高（design §4.4）。
  -->
  <!-- 根元素 max-w-[var(--content-max-w)] mx-auto：整 turn 居中 720px（spec §6.1 R4——
       assistant 居中，UserBubble 列内右浮 max-w-76%）。宽屏下对话流不撑满 panel。 -->
  <div class="mx-auto flex w-full max-w-[var(--content-max-w)] flex-col gap-3.5 pb-5" :data-testid="`turn-${turn.index}`">
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
        :elapsed-secs="elapsedSecs"
        :turn-index="turn.index"
        :turn-key="turnStableId(turn)"
        :session-id="sessionId"
      />

      <!-- trace 容器：恒渲染（v-if 下沉 Block 级——text 恒渲染、thinking/tool/agentgraph 受 showTrace）。
           容器不再进出 DOM，容器级 height 过渡动画随之移除（TC1，折叠动画消失为接受的产品行为变化）。 -->
      <div class="trace mt-1 mb-1 flex flex-col">
        <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
          <template v-for="(blk, bIdx) in traceBlocksByAssistant[aIdx]" :key="`${assistant.id}-${blk.kind}-${bIdx}`">
            <!-- 单块独立渲染。text 折叠态只渲染最后一个（过渡 text 随 trace 折叠，见 lastTextBlockKey）；
                 thinking/tool/agentgraph 受 showTrace 控制。
                 agentgraph（subagent/workflow）数据结构同 tool（ref 是 ToolCall），按 tool 提取 ref；
                 type 透传 'agentgraph'，Block.vue 内部靠 toolName 路由 subagent/workflow 分支。 -->
            <Block
              v-if="blk.kind === 'text' ? (lastTextBlockKey === `${aIdx}-${bIdx}` || showTrace) : showTrace"
              :type="blk.kind"
              :content="blk.kind === 'text' ? (blk.ref as string) : blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).content : undefined"
              :tool="blk.kind === 'tool' || blk.kind === 'agentgraph' ? (blk.ref as ToolCall) : undefined"
              :thinking-id="blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).id : undefined"
              :collapsed="blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).collapsed : undefined"
              :working="sessionActive"
              :streaming="assistant.status === 'streaming'"
              :status="assistant.status"
              :error="assistant.error"
              :session-id="sessionId"
            />
          </template>
        </template>
        <!-- streaming 光标：turn 内容区末尾独立元素（跟在所有 block 后，位置稳定不受 block 增删/折叠态影响）。
             末位可见 block 为 running tool 时隐藏（工具自带 loader，避免光标+loader 并存）。 -->
        <span v-if="showStreamingCursor" class="streaming-tail ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
      </div>

      <!-- 操作栏：TurnSummary 子组件（去内容化后仅 hover actions） -->
      <TurnSummary
        :turn="turn"
        :session-id="sessionId"
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
import { computed } from 'vue'
import type { MessageTurn, OrderedBlock } from '@xyz-agent/core/domain/chat'
import { countThinking, countToolCalls, expandAssistantBlocks, turnStableId } from '@xyz-agent/core/domain/chat'
import type { ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import ChangeSetCard from './ChangeSetCard.vue'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import Block from './Block.vue'
import { useTurnElapsed } from './composables/useTurnElapsed'
import { useChatViewDeps } from './chat-view-deps'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionActive?: boolean
    /** 本 turn 是否为列表末位 turn（D1 折叠作用域修正，streaming-trace-window design §3.3）。
     *  由列表渲染器（MessageStream）按 turn === lastRenderTurn 传入；缺省 false。 */
    isLastTurn?: boolean
  }>(),
  { isSessionActive: undefined },
)

/**
 * B9：编辑状态变化通知父组件。
 */
const emit = defineEmits<{
  'edit-state-change': [{ editing: boolean }]
}>()

const deps = useChatViewDeps()
const { isExpanded, collapse, getChangeSetStatus, isActive } = deps

/** 最后一条 assistant */
const lastAssistant = computed(() => {
  const as = props.turn.assistants
  return as[as.length - 1] ?? null
})

/**
 * isStreaming（turn 级）：文本正在流式生成。
 * sessionActive（session 级）：对话进行中（含 streaming/ask-user/subagent/compacting 等）。
 */
const isStreaming = computed(() => props.turn.isStreaming)
const sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)
/**
 * 本 turn 是否为「工作 turn」（D1：折叠作用域降到 turn 级，streaming-trace-window design §3.3）。
 * session 进行中且本 turn 是列表末位 turn 时才在 run 期间展开 trace——历史 turn 不再因
 * sessionActive 翻真而重展开（F1 修复）。isLastTurn 缺省 false：单 turn 隔离测试须显式传 true。
 */
const isWorkingTurn = computed(() => sessionActive.value && (props.isLastTurn ?? false))

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

// 折叠态经 ChatViewDeps inject（renderer 壳绑 useTurnExpansion store，isExpanded/collapse 已在上方解构）
/** 工作态（仅末位 turn）或手动 expanded 时展开 trace（D1：turn 级作用域，替代旧 sessionActive 驱动）。
 *  [M5 stable-key] 展开态按 turnStableId(turn)（首条消息 id）查询——消息插删时 index 漂移
 *  会错绑展开态，稳定 id 随 turn 本身不变。 */
const showTrace = computed(() => isWorkingTurn.value || isExpanded(turnStableId(props.turn)))

/**
 * 工作耗时 live 计时。
 */
const { elapsed, elapsedSecs } = useTurnElapsed(
  () => props.turn.assistants,
  () => isStreaming.value,
  () => sessionActive.value,
  () => {
    collapse(turnStableId(props.turn))
  },
)

/** 变更集卡（W10） */
const changeSetFileChanges = computed(() => lastAssistant.value?.fileChanges ?? [])
const changeSetStatus = computed(() => {
  const msg = lastAssistant.value
  if (!msg) return undefined
  return getChangeSetStatus(props.sessionId, msg.id)
})

/** 本 session 是否可编辑 */
const isSessionEditable = computed(() => isActive(props.sessionId))

/**
 * trace 内每个 assistant 的有序块（缓存，避免 v-for 内每次 render 重算）。
 * 全量返回 blocks（不再 filter 末位 text——text 全 inline 就地渲染，位置只认 contentBlocks 顺序，
 * 消除「末位 filter」随 message_start 翻转导致的跳变根因）。
 * 每个 block 独立渲染（不再合并连续同类块）。
 * streaming 时每 token 触发 re-render，computed 缓存避免对每个 assistant 重跑 expandAssistantBlocks。
 */
const traceBlocksByAssistant = computed<OrderedBlock[][]>(() => {
  return props.turn.assistants.map((a) => expandAssistantBlocks(a))
})

/**
 * turn 内最后一个 text block 的标识（`${aIdx}-${bIdx}`）。
 * 折叠态（!showTrace）只渲染这一个 text block——工具调用循环中的过渡 text（被工具打断的碎片）
 * 随 trace 折叠，只保留最终回复 text。streaming 中 showTrace=true 全显示，不依赖此值（无跳变：
 * complete 后 blocks 稳定，lastTextBlockKey 不变；历史「末位 filter 跳变」是 streaming 中 filter 导致，
 * 本方案 streaming 全显示故不重蹈）。
 */
const lastTextBlockKey = computed(() => {
  const all = traceBlocksByAssistant.value
  for (let aIdx = all.length - 1; aIdx >= 0; aIdx--) {
    const blocks = all[aIdx]
    for (let bIdx = blocks.length - 1; bIdx >= 0; bIdx--) {
      if (blocks[bIdx].kind === 'text') return `${aIdx}-${bIdx}`
    }
  }
  return null
})

/**
 * streaming-tail 光标显隐（IF2/ES1）：isStreaming && 最后一个可见 block 不是 running tool。
 * 可见性同 Block v-if（text 恒可见，thinking/tool/agentgraph 仅 showTrace 时可见）。
 * 末项 kind 为 tool/agentgraph 且 ref.status === 'running' → 隐藏（工具自带 loader，避免光标+loader 并存）；
 * 其余（含无可见 block 的防御性兜底 ES1）→ 显示。
 */
const showStreamingCursor = computed(() => {
  if (!isStreaming.value) return false
  let lastVisible: OrderedBlock | null = null
  // 复用 traceBlocksByAssistant 缓存（streaming 每 token re-render，避免重跑 expandAssistantBlocks）
  for (const blocks of traceBlocksByAssistant.value) {
    for (const b of blocks) {
      if (b.kind === 'text' || showTrace.value) lastVisible = b
    }
  }
  if (lastVisible && (lastVisible.kind === 'tool' || lastVisible.kind === 'agentgraph')) {
    const ref = lastVisible.ref as ToolCall
    if (ref.status === 'running') return false
  }
  return true
})
</script>
