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
    <!--
      hover actions（W3 精简：可见 affordance ≤4）。
      非 subagent session：copy / fork-bg / fork-ask / ⋯ overflow（copy-MD + handoff + handoff-ask）。
      subagent session：仅 copy + copy-MD（2 个平铺，不走 overflow，避免单项菜单）。
    -->
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
      <!-- subagent session：仅 copy + copy-MD，无 fork/handoff/overflow -->
      <Button
        v-if="isSubagentVirtualId(sessionId)"
        variant="ghost"
        size="icon"
        class="relative size-6 text-neutral-dim hover:text-neutral-fg"
        data-testid="copy-markdown-btn"
        :title="t('panel.message.copyMarkdown')"
        @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
      >
        <Check v-if="copied === aiMdKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
        <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[var(--text-2xs)] font-bold leading-[10px] text-accent-foreground">MD</span>
      </Button>
      <!-- 非 subagent session：fork 组 + overflow -->
      <template v-else>
        <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
        <Button
          variant="ghost"
          size="icon"
          class="fork-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
          data-testid="fork-background-btn"
          :title="t('panel.message.forkBackground')"
          @click="onFork(lastAssistant)"
        >
          <GitFork class="size-3" />
          <span class="as-fork-kbd absolute -right-0.5 -top-0.5 rounded-[3px] bg-surface-2 px-1 font-mono text-[var(--text-2xs)] font-medium text-neutral-dim">{{ formatKbd('g') }}</span>
        </Button>
        <!--
          fork-ask：与 fork-bg 同 ghost icon-only 样式（critique P3：同族图标同尺寸，
          仅靠 kbd（shift+g）和 title 区分）。
        -->
        <Button
          variant="ghost"
          size="icon"
          class="fork-ask-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
          data-testid="fork-ask-btn"
          :title="t('panel.message.forkAsk')"
          @click="onForkAsk(lastAssistant)"
        >
          <GitFork class="size-3 fill-current" />
          <span class="as-fork-kbd absolute -right-0.5 -top-0.5 rounded-[3px] bg-surface-2 px-1 font-mono text-[var(--text-2xs)] font-medium text-neutral-dim">{{ formatKbd('shift+g') }}</span>
        </Button>
        <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
        <!-- ⋯ overflow：copy-MD / handoff / handoff-ask -->
        <Popover v-model:open="overflowOpen">
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="size-6 text-neutral-dim hover:text-neutral-fg"
              data-testid="more-actions-btn"
              :title="t('panel.message.moreActions')"
              :aria-label="t('panel.message.moreActions')"
            >
              <MoreHorizontal class="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" :side-offset="6">
            <div class="flex flex-col py-1">
              <PopoverActionItem
                test-id="copy-markdown-btn"
                @click="overflowCopyMarkdown"
              >
                <template #icon>
                  <Check v-if="copied === aiMdKey" class="text-success" />
                  <Copy v-else />
                </template>
                {{ t('panel.message.copyMarkdown') }}
              </PopoverActionItem>
              <PopoverActionItem
                test-id="handoff-btn"
                :class="{ 'opacity-50 pointer-events-none': isHandingOff }"
                @click="overflowHandoff"
              >
                <template #icon>
                  <Upload />
                </template>
                {{ t('panel.message.handoff') }}
              </PopoverActionItem>
              <PopoverActionItem
                test-id="handoff-ask-btn"
                :class="{ 'opacity-50 pointer-events-none': isHandingOff }"
                @click="overflowHandoffAsk"
              >
                <template #icon>
                  <Upload class="fill-current" />
                </template>
                {{ t('panel.message.handoffAsk') }}
              </PopoverActionItem>
            </div>
          </PopoverContent>
        </Popover>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, GitFork, MoreHorizontal, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverActionItem,
} from '@/components/ui/popover'
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

/** overflow 菜单受控开关：选中后立即关闭 */
const overflowOpen = ref(false)

/**
 * overflow 项动作：先关菜单再执行。
 * 仅在 `v-if="lastAssistant"` 内调用，故 lastAssistant 此处必非空——
 * runtime guard 兼顾 TS 收窄（template 内的 v-if narrowing 不跨闭包生效）。
 */
function overflowCopyMarkdown(): void {
  overflowOpen.value = false
  if (!props.lastAssistant) return
  copy(assistantToMarkdown(props.lastAssistant), aiMdKey.value)
}

function overflowHandoff(): void {
  overflowOpen.value = false
  onHandoff()
}

function overflowHandoffAsk(): void {
  overflowOpen.value = false
  if (!props.lastAssistant) return
  onHandoffAsk(props.lastAssistant)
}

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
