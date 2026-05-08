<template>
  <div class="context-bar">
    <div class="context-bar__track">
      <div
        class="context-bar__fill"
        :style="{ width: clamped + '%', background: barColor }"
      ></div>
    </div>
    <span class="context-bar__label">{{ clamped }}%</span>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { send } from '../../lib/ws-client'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'

const BAR_FULL = 100
const THRESHOLD_HIGH = 85
const THRESHOLD_MEDIUM = 60

const props = defineProps<{ percentage: number }>()

const chatStore = useChatStore()
const sessionStore = useSessionStore()

// Auto-compact when server-reported context exceeds 85% during generation
watch(() => chatStore.contextUsagePercent, (pct) => {
  if (pct > THRESHOLD_HIGH && chatStore.isGenerating) {
    const sid = sessionStore.currentSessionId
    if (sid) {
      send({ type: 'session.compact', payload: { sessionId: sid } })
    }
  }
})

const clamped = computed(() => Math.min(BAR_FULL, Math.max(0, Math.round(props.percentage))))

const barColor = computed(() => {
  if (clamped.value > THRESHOLD_HIGH) return 'var(--danger)'
  if (clamped.value >= THRESHOLD_MEDIUM) return 'var(--warning)'
  return 'var(--success)'
})
</script>

<style scoped>
.context-bar {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  height: 28px;
  flex-shrink: 0;
}

.context-bar__track {
  width: 40px;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar__fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-bar__label {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--muted);
  white-space: nowrap;
  min-width: 30px;
  text-align: right;
}
</style>
