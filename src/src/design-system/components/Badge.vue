<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '../utils'

type BadgeVariant = 'success' | 'warning' | 'danger' | 'idle'

interface Props {
  variant?: BadgeVariant
  dot?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'idle',
  dot: false,
})

const variantColorMap: Record<BadgeVariant, string> = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  idle: 'var(--color-text-muted)',
}

const badgeClasses = computed(() =>
  cn(
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
  ),
)

const dotClasses = computed(() =>
  cn('inline-block h-1.5 w-1.5 rounded-full'),
)

const dotColor = computed(() => variantColorMap[props.variant])

const bgOpacity = computed(() => {
  switch (props.variant) {
    case 'success':
    case 'warning':
    case 'danger':
      return '0.1'
    case 'idle':
    default:
      return '0.05'
  }
})
</script>

<template>
  <span
    :class="badgeClasses"
    :style="{
      color: variantColorMap[variant],
      background: `color-mix(in oklch, ${variantColorMap[variant]} ${bgOpacity}, transparent)`,
    }"
    role="status"
  >
    <span
      v-if="dot"
      :class="dotClasses"
      :style="{ background: dotColor }"
      aria-hidden="true"
    />
    <slot />
  </span>
</template>
