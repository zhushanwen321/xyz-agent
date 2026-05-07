<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '../utils'

type ProgressVariant = 'accent' | 'warning' | 'danger'

interface Props {
  value?: number
  variant?: ProgressVariant
}

const props = withDefaults(defineProps<Props>(), {
  value: 0,
  variant: 'accent',
})

const variantColorMap: Record<ProgressVariant, string> = {
  accent: 'var(--accent)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
}

const PERCENT_MAX = 100
const PERCENT_MIN = 0

const clampedValue = computed(() => Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, props.value)))

const trackClasses = computed(() =>
  cn(
    'relative h-2 w-full overflow-hidden rounded-full',
  ),
)

const indicatorClasses = computed(() =>
  cn('h-full rounded-full transition-all duration-300 ease-in-out'),
)

const barColor = computed(() => variantColorMap[props.variant])
</script>

<template>
  <div
    :class="trackClasses"
    :style="{ background: 'var(--border)' }"
    role="progressbar"
    :aria-valuenow="clampedValue"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="`${clampedValue}% progress`"
  >
    <div
      :class="indicatorClasses"
      :style="{
        width: `${clampedValue}%`,
        background: barColor,
      }"
    />
  </div>
</template>
