<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
}>()

const inputText = ref('')
const isFocused = ref(false)

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  inputText.value = ''
}
</script>

<template>
  <div class="border-t border-border-default bg-bg-base px-4 py-3">
    <div
      class="flex items-end gap-3"
      :class="isFocused ? 'border-b-2 border-accent pb-[1px]' : 'border-b-2 border-transparent pb-0.5'"
    >
      <!-- 终端前缀 -->
      <span class="shrink-0 pb-2 font-mono text-sm text-accent">&gt;</span>

      <!-- 输入框 -->
      <textarea
        v-model="inputText"
        :disabled="isStreaming"
        placeholder="输入消息..."
        class="min-h-[52px] max-h-[200px] flex-1 resize-none bg-transparent font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
        rows="2"
        @keydown="handleKeydown"
        @focus="isFocused = true"
        @blur="isFocused = false"
      />

      <!-- 发送按钮 -->
      <button
        :disabled="isStreaming || !inputText.trim()"
        class="mb-1 flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-xs text-text-tertiary transition-colors hover:bg-accent-muted hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        @click="handleSend"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
        <span>Enter</span>
      </button>
    </div>
  </div>
</template>
