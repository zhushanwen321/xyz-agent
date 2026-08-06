<template>
  <!--
    TurnSummary：收尾 summary + streaming cursor + hover actions（复制/MD/fork/handoff）。
    从 Turn.vue 拆出。fork/handoff useTurnActions 在内部调用，不冒泡。
  -->
  <div
    v-if="summaryText"
    class="turn-summary pt-3 text-[length:var(--text-base)] leading-7 transition-colors duration-200"
    :class="isStreaming ? 'text-neutral-mid' : 'text-neutral-fg'"
  >
    <MarkdownRenderer :content="summaryText" :session-id="sessionId" />
    <!-- streaming 光标：行内闪烁竖条，紧跟 summary 末尾 -->
    <span v-if="isStreaming" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
    <!--
      hover actions（3 个 split-button：copy / fork / handoff）。
      每个 split-button 主按钮 click = 主操作；hover 浮出第二选项（带 MD/MSG badge）。
      非 subagent session：copy / fork / handoff（3 组，sep 分隔）。
      subagent session：仅 copy split-button（含 copy-MD hover 选项，无 fork/handoff）。
    -->
    <div
      v-if="lastAssistant"
      class="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/ai:opacity-100 group-focus-within/ai:opacity-100"
    >
      <!-- copy split-button：主=复制纯文本，hover=复制为 Markdown（MD badge） -->
      <HoverCard :open-delay="150" :close-delay="100">
        <HoverCardTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-6 text-neutral-dim hover:text-neutral-fg"
            data-testid="copy-btn"
            :title="t('panel.message.copy')"
            @click="copy(summaryText, aiCopyKey)"
          >
            <Check v-if="copied === aiCopyKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
          </Button>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="center" :side-offset="6" class="min-w-0 p-1">
          <Button
            variant="ghost"
            size="icon"
            class="relative size-6 text-neutral-dim hover:text-neutral-fg"
            data-testid="copy-markdown-btn"
            :title="t('panel.message.copyMarkdown')"
            @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
          >
            <Check v-if="copied === aiMdKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
            <span class="absolute -right-0.5 -bottom-0.5 rounded-sm bg-accent px-[2px] text-[8px] font-bold leading-[8px] text-accent-foreground">MD</span>
          </Button>
        </HoverCardContent>
      </HoverCard>
      <!-- subagent session：仅 copy split-button，无 fork/handoff -->
      <template v-if="!isSubagentVirtualId(sessionId)">
        <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
        <!-- fork split-button：主=fork 后台，hover=fork 提问（MSG badge，fill-current 区分） -->
        <HoverCard :open-delay="150" :close-delay="100">
          <HoverCardTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="fork-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
              data-testid="fork-background-btn"
              :title="t('panel.message.forkBackground')"
              @click="onFork(lastAssistant)"
            >
              <GitFork class="size-3" />
            </Button>
          </HoverCardTrigger>
          <HoverCardContent side="top" align="center" :side-offset="6" class="min-w-0 p-1">
            <Button
              variant="ghost"
              size="icon"
              class="fork-ask-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
              data-testid="fork-ask-btn"
              :title="t('panel.message.forkAsk')"
              @click="onForkAsk(lastAssistant)"
            >
              <GitFork class="size-3 fill-current" />
              <span class="absolute -right-0.5 -bottom-0.5 rounded-sm bg-accent px-[2px] text-[8px] font-bold leading-[8px] text-accent-fg">+Q</span>
            </Button>
          </HoverCardContent>
        </HoverCard>
        <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
        <!-- handoff split-button：主=交接并新开，hover=交接并备注（MSG badge，fill-current 区分） -->
        <HoverCard :open-delay="150" :close-delay="100">
          <HoverCardTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              :class="['handoff-btn relative size-6 text-neutral-dim hover:text-neutral-fg', { 'opacity-50 pointer-events-none': isHandingOff }]"
              data-testid="handoff-btn"
              :title="t('panel.message.handoff')"
              @click="onHandoff()"
            >
              <HandHelping class="size-3.5 fill-current" />
            </Button>
          </HoverCardTrigger>
          <HoverCardContent side="top" align="center" :side-offset="6" class="min-w-0 p-1">
            <Button
              variant="ghost"
              size="icon"
              :class="['handoff-ask-btn relative size-6 text-neutral-dim hover:text-neutral-fg', { 'opacity-50 pointer-events-none': isHandingOff }]"
              data-testid="handoff-ask-btn"
              :title="t('panel.message.handoffAsk')"
              @click="onHandoffAsk(lastAssistant)"
            >
              <HandHelping class="size-3 fill-current" />
              <span class="absolute -right-0.5 -bottom-0.5 rounded-sm bg-accent px-[2px] text-[8px] font-bold leading-[8px] text-accent-fg">+Q</span>
            </Button>
          </HoverCardContent>
        </HoverCard>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, GitFork, HandHelping } from '@lucide/vue'
import { Button, HoverCard, HoverCardContent, HoverCardTrigger } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Message } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import { useCopy } from './composables/useCopy'
import { isSubagentVirtualId } from '../../lib/subagent-id'
import { useChatViewDeps } from './chat-view-deps'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  turn: MessageTurn
  sessionId: string
  isStreaming: boolean
  lastAssistant: Message | null
}>()

const { t } = useI18n()
const deps = useChatViewDeps()

/** fork/handoff hover action handler（经 deps 桥接 useTurnActions） */
function onFork(msg: Message): void { deps.onFork(props.sessionId, msg) }
function onForkAsk(msg: Message): void { deps.onForkAsk(props.sessionId, msg) }
function onHandoff(): void { deps.onHandoff(props.sessionId) }
function onHandoffAsk(msg: Message): void { deps.onHandoffAsk(props.sessionId, msg) }
/** copy-as-markdown（经 deps.toMarkdown 桥接 renderer messageFormat） */
function assistantToMarkdown(msg: Message): string { return deps.toMarkdown(msg) }

/** 本 session 是否正在交接（防 handoff 按钮重复点击） */
const isHandingOff = computed(() => deps.isHandingOff(props.sessionId))

/** 复制反馈 */
const { copied, copy } = useCopy()
const aiCopyKey = computed(() => `ai-${props.turn.index}`)
const aiMdKey = computed(() => `md-${props.turn.index}`)

/**
 * 收尾 summary：仅最后一条 assistant.content。
 * streaming 和 complete 态都渲染。
 */
const summaryText = computed(() => {
  const as = props.turn.assistants
  const last = as[as.length - 1]
  if (!last?.content) return ''
  const text = normalizeContent(last.content)
  return text.trim() ? text : ''
})
</script>
