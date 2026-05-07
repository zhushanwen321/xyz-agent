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
import { computed } from 'vue'

const BAR_FULL = 100
const THRESHOLD_HIGH = 85
const THRESHOLD_MEDIUM = 60

const props = defineProps<{ percentage: number }>()

const clamped = computed(() => Math.min(BAR_FULL, Math.max(0, Math.round(props.percentage))))

const barColor = computed(() => {
  if (clamped.value > THRESHOLD_HIGH) return 'var(--color-danger)'
  if (clamped.value >= THRESHOLD_MEDIUM) return 'var(--color-warning)'
  return 'var(--color-success)'
})
</script>

<style scoped>
.context-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.context-bar__track {
  flex: 1;
  height: 4px;
  background: var(--color-border);
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
  color: var(--color-text-muted);
  white-space: nowrap;
  min-width: 30px;
  text-align: right;
}
</style>
