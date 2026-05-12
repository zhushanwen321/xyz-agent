<template>
  <div class="text-[11px] text-muted font-mono inline-flex items-center gap-1 px-1.5 h-7 shrink-0">
    <div class="w-10 h-1 bg-border rounded-sm overflow-hidden">
      <div
        class="h-full rounded-sm transition-all duration-300 ease-ease"
        :style="{ width: clamped + '%', background: barColor }"
      ></div>
    </div>
    <span class="text-[11px] font-mono text-muted whitespace-nowrap min-w-[30px] text-right">{{ clamped }}%</span>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { send } from '../../lib/ws-client'
import { useChatStore } from '../../stores/chat'

const BAR_FULL = 100
const THRESHOLD_HIGH = 85
const THRESHOLD_MEDIUM = 60

const props = defineProps<{
  percentage: number
  sessionId?: string
}>()

const chatStore = useChatStore()

// Auto-compact when server-reported context exceeds 85% during generation
watch(() => props.percentage, (pct) => {
  if (pct > THRESHOLD_HIGH && props.sessionId) {
    const s = chatStore.getSessionState(props.sessionId)
    if (s.isGenerating) {
      send({ type: 'session.compact', payload: { sessionId: props.sessionId } })
    }
  }
})

const clamped = computed(() => Math.min(BAR_FULL, Math.max(0, Math.round(props.percentage))))

const barColor = computed(() => {
  if (clamped.value > THRESHOLD_HIGH) return 'var(--danger)'
  if (clamped.value >= THRESHOLD_MEDIUM) return 'var(--warning)'
  return 'var(--accent)'
})
</script>


