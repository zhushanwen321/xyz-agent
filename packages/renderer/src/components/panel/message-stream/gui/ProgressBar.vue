<script setup lang="ts">
/**
 * 进度条组件——替代 TUI 的 ████░░░░。
 * severity 映射语义色（ok=success / warn=warning / danger=danger），
 * 未传时按 current/total 比例自动推断。
 */
import { computed } from 'vue'

const props = defineProps<{
  label?: string
  current: number
  total: number
  unit?: string
  severity?: 'ok' | 'warn' | 'danger'
}>()

/** severity 自动推断阈值（ratio = current/total） */
const SEVERITY_THRESHOLD_OK = 0.8
const SEVERITY_THRESHOLD_WARN = 0.5
const PERCENT_MULTIPLIER = 100

const ratio = computed(() => (props.total > 0 ? props.current / props.total : 0))
const percent = computed(() => `${(ratio.value * PERCENT_MULTIPLIER).toFixed(1)}%`)

const resolvedSeverity = computed<'ok' | 'warn' | 'danger'>(() => {
  if (props.severity) return props.severity
  if (ratio.value >= SEVERITY_THRESHOLD_OK) return 'ok'
  if (ratio.value >= SEVERITY_THRESHOLD_WARN) return 'warn'
  return 'danger'
})

const fillClass = computed(() => {
  const map = { ok: 'bg-success', warn: 'bg-warning', danger: 'bg-danger' } as const
  return map[resolvedSeverity.value]
})
</script>

<template>
  <div class="progress-bar flex flex-col gap-1.5 font-mono text-[12px]" data-testid="gui-progress-bar">
    <div class="flex items-center justify-between">
      <span v-if="label" class="text-muted">{{ label }}</span>
      <span class="font-medium tabular-nums text-fg">
        {{ current }}<span class="text-subtle"> / {{ total }}{{ unit ? ` ${unit}` : '' }}</span>
      </span>
    </div>
    <div class="progress-bar__track h-1.5 overflow-hidden rounded-sm bg-bg-input">
      <div
        class="progress-bar__fill h-full rounded-sm transition-[width] duration-300"
        :class="fillClass"
        :style="{ width: percent }"
      />
    </div>
  </div>
</template>
