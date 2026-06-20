<template>
  <!--
    展示组件 · 回合（message-stream 单个 turn，draft-message-stream §1）。
    结构：user 气泡（靠右）+ assistant 区。
    assistant 区 = turn-meta（已工作按钮 / 工作中态）+ 折叠 trace（thinking/tool）+ 收尾 summary text。
    - 纯文字回合（无 thinking/tool）：无折叠条，summary 直接接气泡（draft 画廊 A）
    - working 态（最后一条 assistant streaming）：脉冲点 + 实时计时，trace 默认展开
    - trace 折叠由本地 expanded ref 控制（localStorage 记忆 G-031 DEFERRED，v1 仅 session 内）
  -->
  <div class="flex flex-col gap-3.5">
    <!-- user 气泡：靠右，圆角不对称（右下尖角），无标签行 -->
    <div v-if="turn.user" class="bubble-user self-end max-w-[76%]">
      {{ turn.user.content }}
    </div>

    <!-- assistant 区：背景融为一体，透明无边框 -->
    <div class="flex flex-col gap-0 self-stretch">
      <!-- turn-meta：有可折叠块才显示按钮；working 态用脉冲点 -->
      <Button
        v-if="turn.hasFoldable"
        variant="ghost"
        size="sm"
        class="turn-meta h-auto justify-start gap-2.5 rounded-none p-[5px_2px] font-sans text-[12.5px] font-medium"
        :class="{ working: turn.isWorking }"
        :disabled="turn.isWorking"
        @click="expanded = !expanded"
      >
        <ChevronRight v-if="!turn.isWorking" class="chev size-[9px] text-subtle" />
        <span v-else class="working-dot" />
        <span class="text-[12.5px] font-medium">
          <span class="lbl">{{ turn.isWorking ? '工作中' : '已工作' }}</span>
          <span class="elapsed font-mono font-medium text-fg">{{ elapsed }}</span>
        </span>
        <span v-if="thinkCount > 0" class="badge badge-think">
          <Brain class="size-2.5" />思考 ×{{ thinkCount }}
        </span>
        <span v-if="toolCount > 0" class="badge badge-tool">
          <Wrench class="size-2.5" />工具 ×{{ toolCount }}
        </span>
      </Button>

      <!-- 折叠 trace：working 或 expanded 时展开 -->
      <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
        <template v-for="assistant in turn.assistants" :key="assistant.id">
          <Block
            v-for="th in assistant.thinking ?? []"
            :key="`th-${th.id}`"
            type="thinking"
            :content="th.content"
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

      <!-- 收尾 summary（assistant.content 拼接，draft turn-summary，恒显） -->
      <div v-if="summaryText" class="turn-summary pt-3 text-[13.5px] leading-7 text-fg">
        <p>{{ summaryText }}</p>
        <span v-if="isStreamingText" class="streaming-cursor" />
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

/** 收尾 summary：所有 assistant.content 拼接（draft：收尾 output text 恒存在） */
const summaryText = computed(() =>
  props.turn.assistants.map((a) => a.content).filter(Boolean).join('\n\n'),
)

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

<style scoped>
/* user 气泡：靠右，surface-2 底，右下尖角（draft .bubble-user） */
.bubble-user {
  background: var(--surface-hover);
  border: 1px solid var(--border-strong);
  border-radius: 14px 14px 4px 14px;
  padding: 9px 13px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--fg);
}

/* turn-meta：透明点击区，hover 回升（Button variant=ghost 基础上覆盖） */
.turn-meta {
  align-self: flex-start;
  background: transparent;
  color: var(--muted);
  transition: color var(--duration-fast) var(--ease);
  user-select: none;
}
.turn-meta:hover { color: var(--fg); }
.turn-meta .lbl { color: var(--muted); }
.turn-meta .elapsed { letter-spacing: 0.01em; }
.turn-meta .chev { transition: transform var(--duration) var(--ease); }

/* working 态：脉冲点，不可点击 */
.turn-meta.working { cursor: default; }
.turn-meta.working:hover { color: var(--muted); }
.working-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(79, 142, 247, 0.4); }
  50% { opacity: 0.55; box-shadow: 0 0 0 5px rgba(79, 142, 247, 0); }
}

/* 计数 badge */
.badge {
  font: 600 10px/1 var(--font-mono);
  padding: 4px 8px;
  border-radius: 999px;
  letter-spacing: 0.02em;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge-think { color: var(--reasoning); background: rgba(167, 139, 250, 0.12); }
.badge-tool { color: var(--info); background: rgba(56, 189, 248, 0.12); }

/* summary 代码内联高亮（draft .turn-summary code） */
.turn-summary :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  background: rgba(79, 142, 247, 0.1);
  padding: 1px 5px;
  border-radius: 3px;
}

/* 流式光标 */
.streaming-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 1px;
  background: var(--accent);
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
</style>
