<script setup lang="ts">
import { computed } from 'vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from 'radix-vue'
import { cn } from '../utils'

interface SelectOption {
  label: string
  value: string
}

interface Props {
  modelValue?: string
  options?: SelectOption[]
  placeholder?: string
  disabled?: boolean
}

withDefaults(defineProps<Props>(), {
  modelValue: '',
  options: () => [],
  placeholder: 'Select...',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const triggerClasses = computed(() =>
  cn(
    'inline-flex h-10 w-full items-center justify-between rounded-md px-3 py-2 text-sm',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'data-[placeholder]:text-[var(--color-text-muted)]',
  ),
)

const itemClasses = computed(() =>
  cn(
    'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm',
    'outline-none transition-colors',
    'hover:opacity-90',
    'data-[highlighted]:opacity-90',
    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  ),
)
</script>

<template>
  <SelectRoot
    :model-value="modelValue || undefined"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event ?? '')"
  >
    <SelectTrigger
      :class="triggerClasses"
      :style="{ background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }"
      :aria-label="placeholder"
    >
      <SelectValue :placeholder="placeholder" />
      <span class="ml-2 text-xs" style="color: var(--color-text-muted)">▾</span>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 overflow-hidden rounded-md shadow-md"
        :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            :class="itemClasses"
            style="color: var(--color-text-primary)"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              ✓
            </SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
