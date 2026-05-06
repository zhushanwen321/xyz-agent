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
  accent: 'var(--color-accent)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
}

const clampedValue = computed(() => Math.min(100, Math.max(0, props.value)))

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
    :style="{ background: 'var(--color-border)' }"
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
