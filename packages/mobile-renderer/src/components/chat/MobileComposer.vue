<script setup lang="ts">
/**
 * MobileComposer —— 移动端简化输入框 + 发送按钮（spec P4 C1）。
 *
 * Textarea 输入 + 发送按钮。发送走 emit send(text)，父组件（MobileChatView）转 segments 调 useChat.send。
 * 简化版：不含桌面 Composer 的 slash 命令/file chip/thinking 等级（留 P9）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send } from '@lucide/vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

const emit = defineEmits<{ send: [text: string] }>()
const { t } = useI18n()

const text = ref('')
const canSend = computed(() => text.value.trim().length > 0)

function handleSend(): void {
  const trimmed = text.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  text.value = ''
}

function onKeydown(e: KeyboardEvent): void {
  // 移动端通常无 Ctrl+Enter 物理键盘，但保留桌面调试兼容
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="mobile-composer flex shrink-0 items-end gap-2 border-t border-border bg-surface p-3" data-testid="mobile-composer">
    <Textarea
      v-model="text"
      :placeholder="t('mobile.chat.composerPlaceholder')"
      rows="1"
      class="flex-1 resize-none bg-bg-input text-sm"
      data-testid="mobile-composer-input"
      @keydown="onKeydown"
    />
    <Button
      type="button"
      size="icon"
      :disabled="!canSend"
      data-testid="mobile-composer-send"
      class="shrink-0 rounded-full"
      @click="handleSend"
    >
      <Send :size="16" />
    </Button>
  </div>
</template>
