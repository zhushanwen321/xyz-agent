<script setup lang="ts">
import { ref, nextTick } from 'vue'

defineProps<{
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
  cancel: []
}>()

const inputText = ref('')
const isFocused = ref(false)
const isComposing = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  inputText.value = ''
  nextTick(autoResize)
}
</script>

<template>
  <div class="border-t border-border-default bg-bg-base px-4 py-3">
    <div
      class="flex items-center gap-3"
      :class="isFocused ? 'border-b-2 border-accent pb-[1px]' : 'border-b-2 border-transparent pb-[1px]'"
    >
      <!-- 终端前缀 -->
      <span class="shrink-0 font-mono text-sm text-accent">&gt;</span>

      <!-- 输入框 -->
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :disabled="isStreaming"
        placeholder="输入消息..."
        class="min-h-[1.75rem] max-h-[200px] flex-1 resize-none bg-transparent font-mono text-sm leading-[1.75rem] text-text-primary placeholder:text-text-tertiary focus:outline-none"
        rows="1"
        @input="autoResize"
        @keydown="handleKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @focus="isFocused = true"
        @blur="isFocused = false"
      />

      <!-- 发送按钮 / 停止按钮 -->
      <button
        v-if="!isStreaming"
        :disabled="!inputText.trim()"
        class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs text-text-tertiary transition-colors hover:bg-accent-muted hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
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
      <button
        v-else
        class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
        @click="emit('cancel')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
        <span>Stop</span>
      </button>
    </div>
  </div>
</template>
