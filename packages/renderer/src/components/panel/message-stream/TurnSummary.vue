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
      onboarding 气泡（首次出现 fork 按钮时；dismiss 后 localStorage 永久记忆，v-if 自隐）。
      放 action group 上方，作为「action group 的注释」，引导用户视线到 hover 才出现的按钮。
      仅非 subagent session 渲染（fork 仅在此场景存在）。包 wrapper div 控制外边距，不依赖 class 覆盖。
    -->
    <div v-if="lastAssistant && !isSubagentVirtualId(sessionId)" class="mt-2">
      <OnboardingHint hint-key="fork" :text="t('panel.message.onboardingFork')" />
    </div>
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
            <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[length:var(--text-2xs)] font-bold leading-[10px] text-accent-foreground">MD</span>
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
              <span class="as-fork-kbd absolute -right-0.5 -top-0.5 rounded-[3px] bg-surface-2 px-1 font-mono text-[length:var(--text-2xs)] font-medium text-neutral-dim">{{ formatKbd('g') }}</span>
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
              <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[length:var(--text-2xs)] font-bold leading-[10px] text-accent-foreground">MSG</span>
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
              <Upload class="size-3.5 fill-current" />
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
              <Upload class="size-3 fill-current" />
              <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[length:var(--text-2xs)] font-bold leading-[10px] text-accent-foreground">MSG</span>
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
import { Check, Copy, GitFork, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
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
import OnboardingHint from './OnboardingHint.vue'

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
