<script setup lang="ts">
import { computed } from 'vue'
import type { HTMLAttributes } from 'vue'
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
  modelValue?: string | number
  options?: SelectOption[]
  placeholder?: string
  disabled?: boolean
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  options: () => [],
  placeholder: 'Select...',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

const triggerClasses = computed(() =>
  cn(
    'flex h-10 w-full items-center justify-between rounded-md border border-solid border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)]',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'data-[placeholder]:text-[var(--muted)]',
    props.class,
  ),
)

const contentClasses = 'z-[200] overflow-hidden rounded-md border border-solid border-[var(--border)] bg-[var(--surface)] shadow-md'

const itemClasses = computed(() =>
  cn(
    'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-[var(--fg)]',
    'outline-none transition-colors',
    'hover:bg-[var(--accent-light)]',
    'data-[highlighted]:bg-[var(--accent-light)]',
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
      :aria-label="placeholder"
    >
      <SelectValue :placeholder="placeholder" />
      <svg class="ml-2 shrink-0" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--muted)"><path d="M4 6l4 4 4-4"/></svg>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        :avoid-collisions="true"
        side="bottom"
        align="start"
        :sticky="'always'"
        :class="contentClasses"
        role="listbox"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            :class="itemClasses"
            role="option"
            :aria-selected="modelValue === option.value"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>
            </SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
