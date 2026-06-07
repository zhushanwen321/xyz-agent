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
          队列: {{ totalCount }} 条待处理
        </span>
      </div>
      <!-- list -->
      <div class="space-y-1 pb-2">
        <div
          v-for="(item, i) in queueItems"
          :key="i"
          class="flex items-center gap-2 text-[11px]"
        >
          <span :class="['px-1.5 py-0.5 rounded-sm text-[9px] font-medium', badgeClass(item.type)]">
            {{ item.type }}
          </span>
          <span class="truncate flex-1 opacity-70">{{ item.text }}</span>
          <span class="pulsing-dot" />
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
    {{ totalCount }} 条待处理
  </div>

  <!-- Done banner -->
  <div v-if="showDoneBanner" class="text-[11px] text-[var(--success)] py-1.5 px-3.5">
    队列已完成 · {{ doneCount }} 条已处理
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { QueueState } from '@/stores/chat'

const MAX_VISIBLE_ITEMS = 10

interface QueueItem {
  type: 'steer' | 'follow-up'
  text: string
}

const props = defineProps<{
  queueState: QueueState | undefined
}>()

defineEmits<{
  (e: 'send-mode-match', text: string, mode: 'steer' | 'follow-up'): void
}>()

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
const overflowCount = computed(() =>
  Math.max(0, totalCount.value - MAX_VISIBLE_ITEMS)
)

// ── Badge class helper ──

function badgeClass(type: 'steer' | 'follow-up'): string {
  if (type === 'steer') return 'bg-[var(--warning)]/15 text-[var(--warning)]'
  return 'bg-[var(--accent)]/15 text-[var(--accent)]'
}

// ── Done banner ──

const showDoneBanner = ref(false)
const doneCount = ref(0)
let doneTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.queueState,
  (_newVal, oldVal) => {
    const prevHasItems = oldVal
      ? (oldVal.steering.length + oldVal.followUp.length) > 0
      : false
    if (prevHasItems && !hasItems.value) {
      doneCount.value = prevHasItems
        ? (oldVal?.steering.length ?? 0) + (oldVal?.followUp.length ?? 0)
        : 0
      showDoneBanner.value = true
      if (doneTimer) clearTimeout(doneTimer)
      doneTimer = setTimeout(() => {
        showDoneBanner.value = false
      }, 3000)
    }
  }
)
</script>

<style scoped>
.queue-full {
  width: 100%;
  background: var(--surface);
  transition: height 0.15s ease;
  overflow: hidden;
}

/* Container query: wide panel shows queue-full, hides queue-compact */
@container (min-width: 520px) {
  .queue-full {
    display: block;
  }
  .queue-compact {
    display: none;
  }
}

/* Container query: narrow panel hides queue-full, shows queue-compact */
@container (max-width: 519px) {
  .queue-full {
    display: none;
  }
  .queue-compact {
    display: block;
  }
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
