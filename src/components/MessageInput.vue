<script setup lang="ts">
import { ref } from 'vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

defineProps<{
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
}>()

const inputText = ref('')

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
  <div class="flex items-end gap-2 border-t bg-background px-4 py-3">
    <Textarea
      v-model="inputText"
      :disabled="isStreaming"
      placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
      class="min-h-[60px] max-h-[200px] resize-none"
      rows="2"
      @keydown="handleKeydown"
    />
    <Button
      :disabled="isStreaming || !inputText.trim()"
      size="icon"
      class="h-10 w-10 shrink-0"
      @click="handleSend"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
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
    </Button>
  </div>
</template>
