<script setup lang="ts">
import { computed } from 'vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'text-white hover:opacity-90 active:opacity-80',
        ghost:
          'border border-solid hover:opacity-80 active:opacity-70',
        danger:
          'text-white hover:opacity-90 active:opacity-80',
      },
      size: {
        sm: 'h-8 px-3 text-sm gap-1.5',
        md: 'h-10 px-4 text-sm gap-2',
        lg: 'h-12 px-6 text-base gap-2.5',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

type ButtonVariants = VariantProps<typeof buttonVariants>

interface Props {
  variant?: NonNullable<ButtonVariants['variant']>
  size?: NonNullable<ButtonVariants['size']>
  as?: string
  disabled?: boolean
  class?: string
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  as: 'button',
  disabled: false,
})

const variantStyles = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'background: var(--accent)'
    case 'ghost':
      return 'background: transparent; border-color: var(--border); color: var(--fg)'
    case 'danger':
      return 'background: var(--danger)'
    default:
      return ''
  }
})

const classes = computed(() => cn(buttonVariants({ variant: props.variant, size: props.size }), props.class))
</script>

<template>
  <component
    :is="as"
    :class="classes"
    :style="variantStyles"
    :disabled="disabled"
    :aria-disabled="disabled || undefined"
  >
    <slot />
  </component>
</template>
