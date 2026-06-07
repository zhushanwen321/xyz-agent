<template>
  <div class="compact-bar">
    <div class="compact-bar__inner" @click="$emit('toggle-all')">
      <span class="compact-bar__label">过程</span>
      <div class="compact-bar__chips" @click.stop>
        <div
          v-for="(chip, ci) in visibleChips"
          :key="ci"
          :class="['compact-chip', `compact-chip--${chip.variant}`, { 'compact-chip--active': expanded.has(ci) }]"
          @click="$emit('toggle-group', ci)"
        >
          <span :class="['compact-chip__dot', `compact-chip__dot--${chip.variant}`]" />
          {{ chip.label }}
          <span v-if="chip.count > 0" class="compact-chip__count">{{ chip.count }}</span>
        </div>
        <!-- Chip type overflow: >4 types -->
        <div
          v-if="chipOverflowCount > 0 && !chipOverflowExpanded"
          class="compact-chip compact-chip--overflow"
          @click.stop="chipOverflowExpanded = true"
        >
          +{{ chipOverflowCount }} more
        </div>
      </div>
      <svg class="compact-bar__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </div>

    <!-- Block groups for expanded chips -->
    <div v-if="expanded.size > 0" class="compact-bar__groups">
      <div
        v-for="(chip, ci) in visibleChips"
        :key="ci"
        v-show="expanded.has(ci)"
        class="compact-group"
      >
        <!-- Individual items for this group -->
        <div
          v-for="(item, ii) in visibleItems(chip, ci)"
          :key="ii"
          class="compact-op"
          @click.stop="item.expanded = !item.expanded"
        >
          <div class="compact-op__hdr">
            <span :class="['compact-op__dot', `compact-op__dot--${chip.variant}`]" />
            <span :class="['compact-op__name', `compact-op__name--${chip.variant}`]">{{ chip.typeLabel }}</span>
            <span class="compact-op__path">{{ item.path }}</span>
            <span class="compact-op__time">{{ item.timeDisplay }}</span>
          </div>
          <div v-if="item.expanded" class="compact-op__body">
            <!-- Thinking block: use ThinkingBlock component -->
            <ThinkingBlock
              v-if="chip.type === 'thinking'"
              :text="resolveThinkingText(item.refId)"
              :start-time="resolveThinking(item.refId)?.startTime"
              :end-time="resolveThinking(item.refId)?.endTime"
            />
            <!-- Tool call: use ToolCallCard component -->
            <ToolCallCard
              v-else
              :tool-call="resolveToolCall(item.refId)!"
            />
          </div>
        </div>
        <!-- Item overflow: >8 items per type, click to expand all -->
        <div
          v-if="chip.overflow > 0 && !itemOverflowExpanded.has(ci)"
          class="compact-op__overflow"
          @click.stop="expandItemAll(ci)"
        >
          还有 {{ chip.overflow }} 个
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { Message, ThinkingBlock as ThinkingBlockType, ToolCall } from '@xyz-agent/shared'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
import { formatTime, toolPath } from '@/lib/compact-utils'

// ── Constants ──
const MAX_VISIBLE_ITEMS = 8
const MAX_VISIBLE_CHIPS = 4

export interface CompactChipItem {
  refId: string
  path: string
  timeDisplay: string
  expanded: boolean
}

export interface CompactChip {
  type: 'thinking' | 'tool'
  variant: 'thinking' | 'tool'
  typeLabel: string
  label: string
  count: number
  overflow: number
  items: CompactChipItem[]
}

const props = defineProps<{
  message: Message
  expanded: Set<number>
}>()

defineEmits<{
  'toggle-group': [index: number]
  'toggle-all': []
}>()

// ── Data resolvers (find original ThinkingBlock/ToolCall by refId) ──

function resolveThinking(refId: string): ThinkingBlockType | undefined {
  return props.message.thinking?.find(b => b.id === refId)
}

function resolveThinkingText(refId: string): string {
  return resolveThinking(refId)?.content ?? ''
}

function resolveToolCall(refId: string): ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}

// ── Reactive chips from message ──
const chips = computed<CompactChip[]>(() => chipData(props.message))

// ── Chip type overflow (>4 types → "+N more") ──
const chipOverflowExpanded = ref(false)

const visibleChips = computed<CompactChip[]>(() => {
  if (chipOverflowExpanded.value || chips.value.length <= MAX_VISIBLE_CHIPS) return chips.value
  return chips.value.slice(0, MAX_VISIBLE_CHIPS)
})

const chipOverflowCount = computed(() =>
  chips.value.length > MAX_VISIBLE_CHIPS ? chips.value.length - MAX_VISIBLE_CHIPS : 0
)

// ── Item overflow (>8 items per type → "还有 N 个", click to expand all) ──
const itemOverflowExpanded = reactive(new Set<number>())

function expandItemAll(index: number) {
  itemOverflowExpanded.add(index)
}

function visibleItems(chip: CompactChip, index: number): CompactChipItem[] {
  if (itemOverflowExpanded.has(index)) return chip.items
  return chip.items.slice(0, MAX_VISIBLE_ITEMS)
}

// ── Helpers (imported from compact-utils) ──

function chipData(msg: Message): CompactChip[] {
  const result: CompactChip[] = []

  // Thinking block group
  if (msg.thinking?.length) {
    const items: CompactChipItem[] = msg.thinking.map(th => ({
      refId: th.id,
      path: '',
      timeDisplay: th.startTime && th.endTime ? formatTime(th.endTime - th.startTime) : '',
      expanded: false,
    }))
    result.push({
      type: 'thinking',
      variant: 'thinking',
      typeLabel: 'Thinking',
      label: '思考',
      count: msg.thinking.length,
      overflow: 0,
      items,
    })
  }

  // Tool calls grouped by toolName
  const toolGroups = new Map<string, typeof msg.toolCalls>()
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      const g = toolGroups.get(tc.toolName) ?? []
      g.push(tc)
      toolGroups.set(tc.toolName, g)
    }
  }

  for (const [name, calls] of toolGroups) {
    if (!calls) continue
    // All items stored, overflow controls visibility
    const items: CompactChipItem[] = calls.map(tc => ({
      refId: tc.id,
      path: toolPath(tc.input),
      timeDisplay: tc.startTime && tc.endTime ? formatTime(tc.endTime - tc.startTime) : '',
      expanded: false,
    }))
    const overflow = Math.max(0, calls.length - MAX_VISIBLE_ITEMS)
    result.push({
      type: 'tool',
      variant: 'tool',
      typeLabel: name,
      label: name,
      count: calls.length,
      overflow,
      items,
    })
  }

  return result
}
</script>

<style scoped>
.compact-bar {
  margin-bottom: 8px;
}

.compact-bar__inner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.compact-bar__inner:hover {
  border-color: var(--accent);
  background: var(--accent-light);
}

.compact-bar__label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-dim, var(--muted));
  margin-right: 2px;
  flex-shrink: 0;
}

.compact-bar__chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  flex: 1;
}

.compact-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 100px;
  font-size: 10px;
  font-family: var(--font-mono);
  line-height: 1.3;
  cursor: pointer;
  transition: all 0.12s;
  user-select: none;
  border: 1px solid transparent;
}
.compact-chip--thinking {
  background: color-mix(in oklch, var(--accent) 12%, transparent);
  color: var(--accent);
}
.compact-chip--thinking:hover {
  background: color-mix(in oklch, var(--accent) 20%, transparent);
}
.compact-chip--tool {
  background: color-mix(in oklch, var(--success) 12%, transparent);
  color: color-mix(in oklch, var(--success) 80%, black);
}
.compact-chip--tool:hover {
  background: color-mix(in oklch, var(--success) 20%, transparent);
}
.compact-chip--active {
  box-shadow: 0 0 0 1px var(--accent);
}
.compact-chip--thinking.compact-chip--active {
  background: color-mix(in oklch, var(--accent) 20%, transparent) !important;
}
.compact-chip--tool.compact-chip--active {
  background: color-mix(in oklch, var(--success) 20%, transparent) !important;
}
.compact-chip--overflow {
  background: var(--bg);
  color: var(--muted-dim, var(--muted));
  border-color: var(--border);
}
.compact-chip--overflow:hover {
  background: var(--accent-light);
  color: var(--muted);
}

.compact-chip__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}
.compact-chip__dot--thinking { background: var(--accent); }
.compact-chip__dot--tool { background: var(--success); }

.compact-chip__count {
  opacity: 0.7;
  font-size: 9px;
}

.compact-bar__chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--muted-dim, var(--muted));
}

/* ── Block groups ── */
.compact-bar__groups {
  margin-top: 6px;
}

.compact-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.compact-op {
  display: flex;
  flex-direction: column;
  padding: 3px 0 3px 12px;
  border-left: 2px solid var(--border);
  cursor: pointer;
  transition: background 0.1s;
}
.compact-op:hover {
  background: color-mix(in oklch, var(--accent) 6%, transparent);
}

.compact-op__hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  pointer-events: none;
}
.compact-op__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  flex-shrink: 0;
}
.compact-op__dot--thinking { background: var(--accent); }
.compact-op__dot--tool { background: var(--success); }
.compact-op__name {
  font-weight: 500;
  color: var(--accent);
  flex-shrink: 0;
}
.compact-op__name--tool {
  color: color-mix(in oklch, var(--success) 80%, black);
}
.compact-op__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact-op__time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted-dim, var(--muted));
  flex-shrink: 0;
}

.compact-op__body {
  margin: 4px 0 2px 13px;
  padding: 0;
  border: none;
  background: transparent;
}

.compact-op__overflow {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--muted-dim, var(--muted));
  padding: 2px 0 2px 12px;
  border-left: 2px solid transparent;
  cursor: pointer;
}
.compact-op__overflow:hover {
  color: var(--accent);
}
</style>
