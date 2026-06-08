<template>
  <!-- Streaming: compact single-line status bar -->
  <div v-if="isStreaming" class="merge-stream">
    <span class="merge-stream__pulse" />
    <span class="merge-stream__status">{{ streamStatusText }}</span>
    <span v-if="streamElapsed" class="merge-stream__time">{{ streamElapsed }}</span>
  </div>

  <!-- Complete: chip summary bar + expandable blocks -->
  <template v-else>
    <div class="merge-bar" @click="toggleExpand">
      <span class="merge-bar__label">过程</span>
      <div class="merge-bar__chips">
        <span
          v-for="(chip, ci) in chips"
          :key="ci"
          :class="['merge-chip', `merge-chip--${chip.variant}`, { 'merge-chip--active': activeChipFilter === chip.label }]"
          @click.stop="toggleChipFilter(chip.label)"
        >
          {{ chip.label }} ×{{ chip.count }}
        </span>
      </div>
      <svg
        :class="['merge-bar__chevron', { 'merge-bar__chevron--open': expanded }]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      ><path d="m6 9 6 6 6-6" /></svg>
    </div>

    <!-- Expanded blocks -->
    <div v-show="expanded" class="merge-blocks">
      <template v-for="block in filteredBlocks" :key="block.refId">
        <ThinkingBlock
          v-if="block.type === 'thinking'"
          :text="resolveThinkingContent(block.refId)"
          :start-time="resolveThinking(block.refId)?.startTime"
          :end-time="resolveThinking(block.refId)?.endTime"
        />
        <ToolCallCard
          v-else-if="block.type === 'toolCall' && resolveToolCall(block.refId)"
          :tool-call="resolveToolCall(block.refId)!"
        />
      </template>
    </div>
  </template>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { ContentBlock, Message, ThinkingBlock as ThinkingBlockType, ToolCall } from '@xyz-agent/shared'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
import { formatTime, toolPath } from '@/lib/compact-utils'
import { useLiveTimer } from '../../composables/useLiveTimer'

// ── Types ──

interface ChipInfo {
  variant: 'thinking' | 'tool'
  label: string
  count: number
}

// ── Props ──

const props = defineProps<{
  blocks: ContentBlock[]
  message: Message
  isStreaming: boolean
}>()

// ── Expand state (complete mode) ──

const expanded = ref(false)
const activeChipFilter = ref<string | null>(null)

function toggleExpand() {
  expanded.value = !expanded.value
  if (!expanded.value) activeChipFilter.value = null
}

function toggleChipFilter(label: string) {
  // Click chip: expand if not expanded, then toggle filter
  if (!expanded.value) expanded.value = true
  activeChipFilter.value = activeChipFilter.value === label ? null : label
}

// ── Data resolvers ──

function resolveThinking(refId: string): ThinkingBlockType | undefined {
  return props.message.thinking?.find(b => b.id === refId)
}

function resolveThinkingContent(refId: string): string {
  return resolveThinking(refId)?.content ?? ''
}

function resolveToolCall(refId: string): ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}

// ── Expanded block filtering ──

const filteredBlocks = computed(() => {
  if (!activeChipFilter.value) return props.blocks
  const filter = activeChipFilter.value
  return props.blocks.filter(b => {
    if (filter === '思考') return b.type === 'thinking'
    // Tool chip: filter by toolName
    const tc = b.type === 'toolCall' ? resolveToolCall(b.refId) : undefined
    return tc?.toolName === filter
  })
})

// ── Chip summary (complete mode) ──

const chips = computed<ChipInfo[]>(() => {
  const result: ChipInfo[] = []
  const toolCounts = new Map<string, number>()
  let thinkingCount = 0

  for (const block of props.blocks) {
    if (block.type === 'thinking') {
      thinkingCount++
    } else if (block.type === 'toolCall') {
      const tc = resolveToolCall(block.refId)
      if (tc) {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1)
      }
    }
  }

  if (thinkingCount > 0) {
    result.push({ variant: 'thinking', label: '思考', count: thinkingCount })
  }

  for (const [name, count] of toolCounts) {
    result.push({ variant: 'tool', label: name, count })
  }

  return result
})

// ── Streaming status (streaming mode) ──

const TEXT_PREVIEW_MAX = 60
const REFRESH_INTERVAL_MS = 200
const MIN_ELAPSED_MS = 1000

const { now, start: startTimer, stop: stopTimer } = useLiveTimer(REFRESH_INTERVAL_MS)

watch(() => props.isStreaming, (streaming) => {
  if (streaming) startTimer()
  else stopTimer()
}, { immediate: true })

const streamStatusText = computed(() => {
  const msg = props.message

  // Last thinking block still running (endTime === undefined)
  const thinkingBlocks = msg.thinking ?? []
  const lastThinking = thinkingBlocks[thinkingBlocks.length - 1]
  if (lastThinking && lastThinking.endTime === undefined) {
    return '思考中...'
  }

  // Any tool call with status === 'running'
  const toolCalls = msg.toolCalls ?? []
  const runningTc = toolCalls.find(tc => tc.status === 'running')
  if (runningTc) {
    const p = toolPath(runningTc.input)
    return p ? `${runningTc.toolName} ${p}` : `${runningTc.toolName}...`
  }

  // Fallback: latest text delta preview
  if (msg.content) {
    const text = msg.content.trim()
    if (text.length > TEXT_PREVIEW_MAX) return text.slice(0, TEXT_PREVIEW_MAX) + '...'
    return text
  }

  return '等待响应...'
})

const streamElapsed = computed(() => {
  const ts = props.message.timestamp
  if (!ts) return ''
  const ms = Math.max(0, now.value - ts)
  if (ms < MIN_ELAPSED_MS) return ''
  return formatTime(ms)
})
</script>

<style scoped>
/* ── Complete mode: chip summary bar ── */
.merge-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-chip);
  background: var(--bg);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.merge-bar:hover {
  border-color: var(--accent);
}

.merge-bar__label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-dim, var(--muted));
  margin-right: 2px;
  flex-shrink: 0;
}

.merge-bar__chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  flex: 1;
}

.merge-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-family: var(--font-mono);
  line-height: 1.3;
  user-select: none;
}
.merge-chip--thinking {
  background: color-mix(in oklch, var(--accent) 20%, transparent);
  color: var(--accent);
  font-weight: 500;
}
.merge-chip--tool {
  background: color-mix(in oklch, var(--success) 20%, transparent);
  color: var(--success);
  font-weight: 500;
}
.merge-chip--active {
  outline: 1px solid currentColor;
  outline-offset: 1px;
}

.merge-bar__chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--muted-dim, var(--muted));
  transition: transform 0.15s;
}
.merge-bar__chevron--open {
  transform: rotate(180deg);
}

/* ── Expanded blocks ── */
.merge-blocks {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  background: var(--bg);
}

/* ── Streaming mode: compact single-line ── */
.merge-stream {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  height: 24px;
}

.merge-stream__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: merge-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes merge-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}

.merge-stream__status {
  font-size: 11px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merge-stream__time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted-dim, var(--muted));
  flex-shrink: 0;
}
</style>
