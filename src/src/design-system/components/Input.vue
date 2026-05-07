<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '../utils'

interface Props {
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  error?: string
  type?: 'text' | 'password'
  label?: string
  id?: string
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
  error: '',
  type: 'text',
  label: '',
  id: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

// eslint-disable-next-line no-magic-numbers -- random ID generation: radix 36, slice positions
const inputId = computed(() => props.id ?? `input-${Math.random().toString(36).slice(2, 9)}`)

const inputClasses = computed(() =>
  cn(
    'flex h-10 w-full rounded-md px-3 py-2 text-sm transition-colors',
    'placeholder:text-[var(--muted)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    props.error && 'ring-2 ring-[var(--danger)]',
  ),
)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label
      v-if="label"
      :for="inputId"
      class="text-sm font-medium"
      style="color: var(--fg)"
    >
      {{ label }}
    </label>
    <input
      :id="inputId"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="inputClasses"
      :aria-invalid="!!error || undefined"
      :aria-describedby="error ? `${inputId}-error` : undefined"
      style="background: var(--surface); color: var(--fg); border: 1px solid var(--border)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span
      v-if="error"
      :id="`${inputId}-error`"
      class="text-xs"
      style="color: var(--danger)"
      role="alert"
    >
      {{ error }}
    </span>
  </div>
</template>
