<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { ref } from 'vue'
import { cn } from '../utils'

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes['class']
  type?: string
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [payload: string | number]
}>()

const inputRef = ref<HTMLInputElement | null>(null)

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <input
    ref="inputRef"
    :type="type ?? 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    :class="cn(
      'flex h-10 w-full rounded-sm border border-solid border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] transition-colors',
      'placeholder:text-[var(--muted)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
    @input="onInput"
  />
</template>
