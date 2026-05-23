<script setup lang="ts">
import { computed } from 'vue'
import {
  DialogRoot,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from 'radix-vue'
import { cn } from '../utils'

interface Props {
  open?: boolean
  title?: string
}

withDefaults(defineProps<Props>(), {
  open: false,
  title: '',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const overlayClasses = computed(() =>
  cn(
    'fixed inset-0 z-50',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
  ),
)

const contentClasses = computed(() =>
  cn(
    'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
    'rounded-sm p-6 shadow-lg',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
    'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
    'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
    'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
  ),
)
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>

    <DialogPortal>
      <DialogOverlay
        :class="overlayClasses"
        style="background: rgba(0, 0, 0, 0.5)"
      />
      <DialogContent
        :class="contentClasses"
        :style="{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
        }"
        aria-modal="true"
        :aria-describedby="undefined"
        :aria-labelledby="title ? 'dialog-title' : undefined"
      >
        <DialogTitle
          v-if="title"
          id="dialog-title"
          class="text-lg font-semibold leading-none"
          style="color: var(--fg)"
        >
          {{ title }}
        </DialogTitle>

        <div class="mt-4">
          <slot />
        </div>

        <DialogClose
          class="absolute right-4 top-4 inline-flex h-6 w-6 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          style="color: var(--muted)"
          aria-label="Close"
        >
          ✕
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
