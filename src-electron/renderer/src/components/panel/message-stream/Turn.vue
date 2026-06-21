<template>
  <!--
    展示组件 · 回合（message-stream 单个 turn，draft-message-stream §1）。
    结构：user 气泡（靠右）+ assistant 区。
    assistant 区 = turn-meta（已工作按钮 / 工作中态）+ 折叠 trace（thinking/tool/中间 text）+ 收尾 summary text。
    - 纯文字回合（无 thinking/tool）：无折叠条，summary 直接接气泡（draft 画廊 A）
    - working 态（最后一条 assistant streaming）：脉冲点 + 实时计时，trace 默认展开
    - trace 折叠由本地 expanded ref 控制（localStorage 记忆 G-031 DEFERRED，v1 仅 session 内）

    Output Text 中间/收尾拆分（draft §4 规则表）：多 assistant 回合（如 steer 续轮）中，
    非最后一条 assistant.content 折进 trace（中间产出），仅最后一条作收尾 summary 恒显。
    单 assistant 内的中间 text 片段拆分依赖 contentBlocks 时序数据（runtime 尚未填充，DEFER flow-2）。
  -->
  <div class="flex flex-col gap-3.5">
    <!-- user 气泡：靠右，surface-hover 底，右下尖角（draft .bubble-user），无标签行 -->
    <div
      v-if="turn.user"
      class="self-end max-w-[76%] rounded-[14px_14px_4px_14px] border border-border-strong bg-surface-hover px-[13px] py-[9px] text-[13.5px] leading-[1.55] text-fg"
    >
      {{ turn.user.content }}
    </div>

    <!-- assistant 区：背景融为一体，透明无边框 -->
    <div class="flex flex-col gap-0 self-stretch">
      <!-- turn-meta：有可折叠块才显示按钮；working 态用脉冲点 -->
      <Button
        v-if="turn.hasFoldable"
        variant="ghost"
        size="sm"
        class="turn-meta h-auto justify-start gap-2.5 rounded-none px-1 py-1 font-sans text-[12.5px] font-medium text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:text-fg"
        :class="turn.isWorking ? 'cursor-default hover:text-muted' : 'cursor-pointer'"
        :disabled="turn.isWorking"
        @click="expanded = !expanded"
      >
        <ChevronRight
          v-if="!turn.isWorking"
          class="chev size-[9px] text-subtle transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="expanded ? 'rotate-90 text-accent' : ''"
        />
        <span v-else class="working-dot size-[7px] flex-shrink-0 rounded-full bg-accent animate-working-pulse" />
        <span class="text-[12.5px] font-medium">
          <span class="lbl text-muted">{{ turn.isWorking ? '工作中' : '已工作' }}</span>
          <span class="elapsed font-mono font-medium tracking-[0.01em] text-fg">{{ elapsed }}</span>
        </span>
        <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-1 rounded-full bg-[rgba(167,139,250,0.12)] px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-reasoning">
          <Brain class="size-2.5" />思考 ×{{ thinkCount }}
        </span>
        <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-1 rounded-full bg-[rgba(56,189,248,0.12)] px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-info">
          <Wrench class="size-2.5" />工具 ×{{ toolCount }}
        </span>
      </Button>

      <!-- 折叠 trace：working 或 expanded 时展开 -->
      <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
        <!--
          按 assistant 时序渲染 trace 块。
          中间产出 text（非最后一条 assistant.content）折进 trace（draft §4 Output Text 中间）。
        -->
        <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
          <!-- 该 assistant 的非收尾 content（仅多 assistant 时存在）折进 trace -->
          <Block
            v-if="isMidAssistant(aIdx) && assistant.content.trim()"
            type="text"
            :content="assistant.content"
          />
          <Block
            v-for="th in assistant.thinking ?? []"
            :key="`th-${th.id}`"
            type="thinking"
            :content="th.content"
            :collapsed="th.collapsed"
          />
          <Block
            v-for="tc in assistant.toolCalls ?? []"
            :key="`tc-${tc.id}`"
            type="tool"
            :tool="tc"
          />
        </template>
      </div>

      <hr v-if="turn.hasFoldable || turn.assistants.length > 0" class="border-0 border-t border-border" />

      <!-- 收尾 summary：仅最后一条 assistant.content（draft §4：收尾位固定不折叠） -->
      <div v-if="summaryText" class="turn-summary pt-3 text-[13.5px] leading-7 text-fg">
        <p>{{ summaryText }}</p>
        <span v-if="isStreamingText" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] translate-y-[3px] rounded-[1px] bg-accent align-text-bottom animate-blink" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Brain, ChevronRight, Wrench } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { countThinking, countToolCalls } from '@/composables/logic/messageTurns'
import Block from './Block.vue'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

const props = defineProps<{
  turn: MessageTurn
}>()

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

/** working 或 expanded 时展开 trace */
const expanded = ref(false)
const showTrace = computed(() => props.turn.isWorking || expanded.value)

/**
 * 收尾 summary：仅最后一条 assistant.content（draft §4：收尾位固定不折叠，作回合焦点）。
 * 多 assistant 回合（如 steer 续轮）的前序 content 折进 trace（见 isMidAssistant）。
 */
const summaryText = computed(() => {
  const as = props.turn.assistants
  const last = as[as.length - 1]
  return last?.content?.trim() ? last.content : ''
})

/** 该 assistant 是否为「中间产出」（非最后一条）→ content 折进 trace 而非收尾 */
function isMidAssistant(idx: number): boolean {
  return idx < props.turn.assistants.length - 1
}

/** 最后一条 assistant 是否仍 streaming（光标） */
const isStreamingText = computed(() => {
  const last = props.turn.assistants[props.turn.assistants.length - 1]
  return props.turn.isWorking && last?.status === 'streaming'
})

/** 工作耗时（mock：无真实起止，用 assistant 时间戳粗算；working 态显示 live） */
const elapsed = computed(() => {
  const as = props.turn.assistants
  if (as.length === 0) return '0s'
  const first = as[0].timestamp
  const last = as[as.length - 1].timestamp
  const secs = Math.max(1, Math.round((last - first) / MS_PER_SEC))
  const m = Math.floor(secs / SEC_PER_MIN)
  const s = secs % SEC_PER_MIN
  return m > 0 ? `${m}m ${String(s).padStart(SEC_PAD_WIDTH, '0')}s` : `${s}s`
})
</script>
