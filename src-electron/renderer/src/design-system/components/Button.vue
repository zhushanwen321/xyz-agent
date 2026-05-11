<script setup lang="ts">
import { computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-[var(--radius-sm)] font-normal font-[var(--font-body)] text-[13px] cursor-pointer whitespace-nowrap transition-all duration-200 ease-[var(--ease)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent)] text-white border border-[var(--accent)] hover:opacity-[0.88] active:opacity-80',
        outline: 'border border-solid border-[var(--border)] bg-transparent text-[var(--muted)] hover:bg-[var(--accent-light)] hover:text-[var(--accent)] hover:border-[var(--accent)]',
        ghost: 'border-none bg-transparent text-[var(--muted)] hover:bg-[var(--accent-light)] hover:text-[var(--accent)]',
        danger: 'bg-[var(--danger)] text-white border border-[var(--danger)] hover:opacity-[0.88] active:opacity-80',
      },
      size: {
        sm: 'py-[5px] px-3 text-xs gap-[6px] rounded-[var(--radius-xs)]',
        md: 'py-2 px-[18px] gap-1.5',
        lg: 'py-3 px-6 text-base gap-2.5',
        icon: 'h-7 w-7 p-0 rounded-[var(--radius-xs)]',
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
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  as: 'button',
  disabled: false,
})

const classes = computed(() => cn(buttonVariants({ variant: props.variant, size: props.size }), props.class))
</script>

<template>
  <component
    :is="as"
    :class="classes"
    :disabled="disabled"
    :aria-disabled="disabled || undefined"
  >
    <slot />
  </component>
</template>
