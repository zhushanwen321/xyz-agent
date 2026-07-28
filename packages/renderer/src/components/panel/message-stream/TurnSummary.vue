<template>
  <!--
    TurnSummary：收尾 summary + streaming cursor + hover actions（复制/MD/fork/handoff）。
    从 Turn.vue 拆出。fork/handoff useTurnActions 在内部调用，不冒泡。
  -->
  <div
    v-if="summaryText"
    class="turn-summary pt-3 text-[var(--text-base)] leading-7 transition-colors duration-200"
    :class="isStreaming ? 'text-neutral-mid' : 'text-neutral-fg'"
  >
    <MarkdownRenderer :content="summaryText" :session-id="sessionId" />
    <!-- streaming 光标：行内闪烁竖条，紧跟 summary 末尾 -->
    <span v-if="isStreaming" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
    <!-- hover actions：复制 / 复制为 MD（常驻）+ fork（仅 AI 停止时）。 -->
    <div
      v-if="lastAssistant"
      class="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/ai:opacity-100 group-focus-within/ai:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.copy')"
        @click="copy(summaryText, aiCopyKey)"
      >
        <Check v-if="copied === aiCopyKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="relative size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.copyMarkdown')"
        @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
      >
        <Check v-if="copied === aiMdKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
        <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[var(--text-2xs)] font-bold leading-[10px] text-accent-foreground">MD</span>
      </Button>
      <!-- fork 按钮组 -->
      <span v-if="!isSubagentVirtualId(sessionId)" class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
      <Button
        v-if="!isSubagentVirtualId(sessionId)"
        variant="ghost"
        size="sm"
        class="fork-btn h-6 gap-1 px-1.5 text-accent hover:bg-accent-soft hover:text-accent-hover"
        data-testid="fork-background-btn"
        :title="t('panel.message.forkBackground')"
        @click="onFork(lastAssistant)"
      >
        <GitFork class="size-3" />
        <span class="text-[var(--text-xs)]">{{ t('panel.message.forkBackgroundLabel') }}</span>
        <span class="as-fork-kbd rounded-[3px] bg-surface-2 px-1 font-mono text-[9px] font-medium text-neutral-dim">{{ formatKbd('g') }}</span>
      </Button>
      <Button
        v-if="!isSubagentVirtualId(sessionId)"
        variant="ghost"
        size="sm"
        class="fork-ask-btn h-6 gap-1 bg-accent-soft px-1.5 font-semibold text-accent hover:bg-accent hover:text-accent-foreground"
        data-testid="fork-ask-btn"
        :title="t('panel.message.forkAsk')"
        @click="onForkAsk(lastAssistant)"
      >
        <GitFork class="size-3.5 fill-current" />
        <span class="text-[var(--text-xs)]">{{ t('panel.message.forkAskLabel') }}</span>
        <span class="as-fork-kbd rounded-[3px] bg-accent/20 px-1 font-mono text-[9px] font-medium text-accent">{{ formatKbd('shift+g') }}</span>
      </Button>
      <!-- handoff 按钮组 -->
      <span v-if="!isSubagentVirtualId(sessionId)" class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
      <Button
        v-if="!isSubagentVirtualId(sessionId)"
        variant="ghost"
        size="icon"
        class="handoff-btn size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
        data-testid="handoff-btn"
        :disabled="isHandingOff"
        :title="t('panel.message.handoff')"
        @click="onHandoff()"
      >
        <Upload class="size-3" />
      </Button>
      <Button
        v-if="!isSubagentVirtualId(sessionId)"
        variant="ghost"
        size="icon"
        class="handoff-ask-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
        data-testid="handoff-ask-btn"
        :disabled="isHandingOff"
        :title="t('panel.message.handoffAsk')"
        @click="onHandoffAsk(lastAssistant)"
      >
        <Upload class="size-3.5 fill-current" />
        <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, GitFork, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import { useCopy } from '@/composables/effects/useCopy'
import { useChatStore } from '@/stores/chat'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import { isSubagentVirtualId } from '@/stores/subagent'
import { useTurnActions } from '@/composables/panel/useTurnActions'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  turn: MessageTurn
  sessionId: string
  isStreaming: boolean
  lastAssistant: Message | null
}>()

const { t } = useI18n()
const chat = useChatStore()
const { formatKbd } = usePlatformShortcut()

/** fork/handoff hover action handler（内部调用，不冒泡） */
const { onFork, onForkAsk, onHandoff, onHandoffAsk } = useTurnActions({
  sessionId: computed(() => props.sessionId),
  lastAssistant: computed(() => props.lastAssistant),
})

/** 本 session 是否正在交接（防 handoff 按钮重复点击） */
const isHandingOff = computed(() => chat.isHandingOff(props.sessionId))

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
