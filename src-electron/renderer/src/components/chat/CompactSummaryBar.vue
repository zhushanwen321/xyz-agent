<template>
  <div class="compact-bar">
    <div class="compact-bar__inner" @click="$emit('toggle-all')">
      <span class="compact-bar__label">过程</span>
      <div class="compact-bar__chips" @click.stop>
        <div
          v-for="(chip, ci) in chips"
          :key="ci"
          :class="['compact-chip', `compact-chip--${chip.variant}`, { 'compact-chip--active': expanded.has(ci) }]"
          @click="$emit('toggle-group', ci)"
        >
          <span :class="['compact-chip__dot', `compact-chip__dot--${chip.variant}`]" />
          {{ chip.label }}
          <span v-if="chip.count > 0" class="compact-chip__count">{{ chip.count }}</span>
        </div>
      </div>
      <svg class="compact-bar__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </div>

    <!-- Block groups for expanded chips -->
    <div v-if="expanded.size > 0" class="compact-bar__groups">
      <div
        v-for="(chip, ci) in chips"
        :key="ci"
        v-show="expanded.has(ci)"
        class="compact-group"
      >
        <!-- Individual items for this group -->
        <div
          v-for="(item, ii) in chip.items"
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
            <div class="compact-op__body-inner">{{ item.body }}</div>
          </div>
        </div>
        <div v-if="chip.overflow > 0" class="compact-op__overflow">
          还有 {{ chip.overflow }} 个（为演示展示前 {{ chip.items.length }} 个）
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@xyz-agent/shared'

// ── Constants ──
const DECISECOND_MS = 100
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const PATH_MAX_LEN = 40
const MAX_VISIBLE_ITEMS = 8

export interface CompactChipItem {
  path: string
  timeDisplay: string
  body: string
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

defineProps<{
  message: Message
  expanded: Set<number>
}>()

defineEmits<{
  'toggle-group': [index: number]
  'toggle-all': []
}>()

// ── Reactive chips from message ──
const chips = computed<CompactChip[]>(() => chipData(message))

// ── Helpers ──

function formatTime(ms: number): string {
  if (ms < MS_PER_SECOND) return `${(ms / DECISECOND_MS).toFixed(1)}s`
  const s = ms / MS_PER_SECOND
  if (s < SECONDS_PER_MINUTE) return `${s.toFixed(1)}s`
  const m = Math.floor(s / SECONDS_PER_MINUTE)
  const sec = Math.floor(s % SECONDS_PER_MINUTE)
  return `${m}m${sec}s`
}

/** Extract a short path representation from tool call input */
function toolPath(input: unknown): string {
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input
    if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>
      const p = (rec.path ?? rec.file_path ?? rec.command) as string | undefined
      if (p) return p
    }
  // eslint-disable-next-line taste/no-silent-catch -- 优雅降级：解析失败时返回原始输入截断
  } catch (e) {
    console.warn('[CompactSummaryBar] toolPath parse error:', e)
  }
  return String(input ?? '').slice(0, PATH_MAX_LEN)
}

function chipData(msg: Message): CompactChip[] {
  const result: CompactChip[] = []

  // Thinking block group
  if (msg.thinking?.length) {
    const items: CompactChipItem[] = msg.thinking.map(th => ({
      path: '',
      timeDisplay: th.startTime && th.endTime ? formatTime(th.endTime - th.startTime) : '',
      body: th.content || '(thinking content)',
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
    const items: CompactChipItem[] = calls.slice(0, MAX_VISIBLE_ITEMS).map(tc => ({
      path: toolPath(tc.input),
      timeDisplay: tc.startTime && tc.endTime ? formatTime(tc.endTime - tc.startTime) : '',
      body: tc.output ?? '(no output)',
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
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.compact-op__body-inner {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  white-space: pre-wrap;
}

.compact-op__overflow {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--muted-dim, var(--muted));
  padding: 2px 0 2px 12px;
  border-left: 2px solid transparent;
}
</style>
