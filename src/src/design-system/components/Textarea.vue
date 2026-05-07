<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { cn } from '../utils'

interface Props {
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  maxHeight?: string
  autoResize?: boolean
  rows?: number
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
  maxHeight: '140px',
  autoResize: true,
  rows: 3,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)

const textareaClasses = computed(() =>
  cn(
    'flex w-full rounded-md px-3 py-2 text-sm transition-colors',
    'placeholder:text-[var(--muted)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'resize-none',
  ),
)

const maxHeightStyle = computed(() => ({
  'max-height': props.maxHeight,
  overflow: 'auto',
}))

function autoResizeTextarea() {
  const el = textareaRef.value
  if (!el || !props.autoResize) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function onInput(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value
  emit('update:modelValue', value)
  autoResizeTextarea()
}

watch(
  () => props.modelValue,
  () => {
    if (props.autoResize) {
      nextTick(autoResizeTextarea)
    }
  },
)
</script>

<template>
  <textarea
    ref="textareaRef"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows"
    :class="textareaClasses"
    :style="{ ...maxHeightStyle, background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)' }"
    :aria-label="placeholder || undefined"
    @input="onInput"
  />
</template>
