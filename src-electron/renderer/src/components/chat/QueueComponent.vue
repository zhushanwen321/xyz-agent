<template>
  <!-- Wide panel (≥520px): full header + list -->
  <div v-if="hasItems" class="queue-full">
    <div class="max-w-[960px] mx-auto px-6">
      <!-- header -->
      <div class="flex items-center justify-between h-7 text-[11px] text-[var(--muted)]">
        <span class="flex items-center gap-1.5">
          <svg class="w-3 h-3 opacity-60" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
          <span data-i18n="queue.pendingCount">队列: {{ visibleItems.length }} 条待处理</span>
        </span>
      </div>
      <!-- list -->
      <div class="space-y-1 pb-2">
        <div
          v-for="(item, i) in visibleItems"
          :key="i"
          class="flex items-center gap-2 text-[11px]"
        >
          <span :class="['px-1.5 py-0.5 rounded-sm text-[9px] font-medium', badgeClass(item.type)]" :data-i18n="item.type === 'steer' ? 'queue.badge.steer' : 'queue.badge.followup'">
            {{ item.type }}
          </span>
          <span class="truncate flex-1 opacity-70">{{ item.text }}</span>
          <span class="pulsing-dot" data-i18n="queue.waiting" title="等待中" />
        </div>
        <div v-if="overflowCount > 0" class="text-[10px] text-[var(--muted)]">
          +{{ overflowCount }} 更多
        </div>
      </div>
    </div>
  </div>

  <!-- Narrow panel (<520px): inline badge -->
  <div v-if="hasItems" class="queue-compact text-[11px] text-[var(--muted)] px-3.5 py-1 cursor-pointer">
    <svg class="w-3 h-3 opacity-60 inline-block mr-1 -mt-px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
    <span data-i18n="queue.pendingCount">{{ totalCount }} 条待处理</span>
  </div>

  <!-- Done banner -->
  <div v-if="showDoneBanner" class="text-[11px] text-[var(--success)] py-1.5 px-3.5">
    <span data-i18n="queue.done">队列已完成 · {{ doneCount }} 条已处理</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { QueueState } from '@/stores/chat'

const MAX_VISIBLE_ITEMS = 5

interface QueueItem {
  type: 'steer' | 'follow-up'
  text: string
}

const props = defineProps<{
  queueState: QueueState | undefined
}>()

// emit declarations are only needed if the component emits events
// This component has no emits

// ── Derived data ──

const queueItems = computed<QueueItem[]>(() => {
  if (!props.queueState) return []
  const items: QueueItem[] = []
  for (const text of props.queueState.steering) {
    items.push({ type: 'steer', text })
  }
  for (const text of props.queueState.followUp) {
    items.push({ type: 'follow-up', text })
  }
  return items
})

const totalCount = computed(() => queueItems.value.length)
const hasItems = computed(() => totalCount.value > 0)
const visibleItems = computed(() => queueItems.value.slice(0, MAX_VISIBLE_ITEMS))
const overflowCount = computed(() =>
  Math.max(0, totalCount.value - MAX_VISIBLE_ITEMS)
)

// ── Badge class helper ──

function badgeClass(type: 'steer' | 'follow-up'): string {
  if (type === 'steer') return 'badge-steer'
  return 'badge-follow-up'
}

// ── Done banner ──
const DONE_BANNER_DURATION_MS = 3000

const showDoneBanner = ref(false)
const doneCount = ref(0)
let doneTimer: ReturnType<typeof setTimeout> | undefined

// B1 fix: track prevCount via ref, not oldVal (reactive object reference is stale)
const prevCount = ref(0)

watch(totalCount, (newCount) => {
  if (prevCount.value > 0 && newCount === 0) {
    doneCount.value = prevCount.value
    showDoneBanner.value = true
    if (doneTimer) clearTimeout(doneTimer)
    doneTimer = setTimeout(() => {
      showDoneBanner.value = false
    }, DONE_BANNER_DURATION_MS)
  }
  prevCount.value = newCount
})

// S3 fix: cleanup timer on unmount
onBeforeUnmount(() => {
  if (doneTimer) clearTimeout(doneTimer)
})
</script>

<style scoped>
.queue-full {
  width: 100%;
  background: var(--surface);
  transition: height 0.15s ease;
  overflow: hidden;
}

/* B2 fix: match container-name from style.css */
@container panel (min-width: 480px) {
  .queue-full { display: block; }
  .queue-compact { display: none; }
}

@container panel (max-width: 481px) {
  .queue-full { display: none; }
  .queue-compact { display: block; }
}

/* W2 fix: use scoped classes instead of arbitrary value + opacity syntax */
.badge-steer {
  background: color-mix(in oklch, var(--warning) 15%, transparent);
  color: var(--warning);
}

.badge-follow-up {
  background: color-mix(in oklch, var(--accent) 15%, transparent);
  color: var(--accent);
}

.pulsing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@media (prefers-reduced-motion: reduce) {
  .pulsing-dot {
    animation: none;
    opacity: 0.6;
  }
}
</style>
