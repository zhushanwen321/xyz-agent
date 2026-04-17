<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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

const MAX_TEXTAREA_HEIGHT = 200

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px'
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
  <div class="border-t border-border-default bg-base px-4 py-3">
    <div
      class="flex items-center gap-3"
      :class="isFocused ? 'border-b-2 border-semantic-green pb-[1px]' : 'border-b-2 border-transparent pb-[1px]'"
    >
      <!-- 终端前缀 -->
      <span class="shrink-0 font-mono text-sm text-semantic-green">&gt;</span>

      <!-- 输入框 -->
      <Textarea
        ref="textareaRef"
        v-model="inputText"
        :disabled="isStreaming"
        placeholder="输入消息..."
        class="min-h-[1.75rem] max-h-[200px] flex-1 resize-none bg-transparent font-mono text-sm leading-[1.75rem] text-foreground placeholder:text-tertiary focus:outline-none"
        rows="1"
        @input="autoResize"
        @keydown="handleKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @focus="isFocused = true"
        @blur="isFocused = false"
      />

      <!-- 发送按钮 / 停止按钮 -->
      <Button
        v-if="!isStreaming"
        variant="ghost"
        size="sm"
        :disabled="!inputText.trim()"
        class="shrink-0 font-mono text-xs text-tertiary hover:bg-semantic-green/15 hover:text-semantic-green disabled:opacity-30"
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
      </Button>
      <Button
        v-else
        variant="ghost"
        size="sm"
        class="shrink-0 font-mono text-xs text-semantic-red hover:bg-semantic-red/10 hover:text-semantic-red"
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
      </Button>
    </div>
  </div>
</template>
