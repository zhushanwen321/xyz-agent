<script setup lang="ts">
import { computed } from 'vue'
import { SwitchRoot, SwitchThumb } from 'radix-vue'
import { cn } from '../utils'

interface Props {
  checked?: boolean
  disabled?: boolean
}

withDefaults(defineProps<Props>(), {
  checked: false,
  disabled: false,
})

const emit = defineEmits<{
  'update:checked': [value: boolean]
}>()

const rootClasses = computed(() =>
  cn(
    'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'data-[state=checked]:bg-[var(--color-accent)]',
    'data-[state=unchecked]:bg-[var(--color-border)]',
  ),
)

const thumbClasses = computed(() =>
  cn(
    'pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform',
    'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5',
  ),
)
</script>

<template>
  <SwitchRoot
    :checked="checked"
    :disabled="disabled"
    :class="rootClasses"
    :aria-checked="checked"
    role="switch"
    @update:checked="emit('update:checked', $event)"
  >
    <SwitchThumb
      :class="thumbClasses"
      :style="{ background: 'var(--color-surface)' }"
    />
  </SwitchRoot>
</template>
