<template>
  <div class="chat-panel">
    <div class="panel-bar">
      <span class="panel-title">{{ t('chat.assistant') }}</span>
    </div>
    <MessageList :messages="chatStore.messages" />
    <StreamingMessage
      v-if="chatStore.streamingMessage"
      :message="chatStore.streamingMessage"
      :is-streaming="chatStore.isGenerating"
    />
    <div class="chat-input-area">
      <textarea
        v-model="inputText"
        :placeholder="t('chat.inputPlaceholder')"
        class="chat-textarea"
        rows="1"
        @keydown.enter.prevent="handleSend"
      ></textarea>
      <div class="chat-toolbar">
        <button class="tb-btn" @click="handleSend" v-if="!chatStore.isGenerating">{{ t('chat.send') }}</button>
        <button class="tb-btn tb-btn-stop" @click="handleStop" v-else>{{ t('chat.stop') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useI18n } from 'vue-i18n'
import { send } from '../../lib/ws-client'
import MessageList from './MessageList.vue'
import StreamingMessage from './StreamingMessage.vue'

const { t } = useI18n()
const chatStore = useChatStore()
const inputText = ref('')

function handleSend() {
  if (!inputText.value.trim()) return
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content: inputText.value,
    status: 'complete',
    timestamp: Date.now(),
  })
  send({ type: 'message.send', payload: { sessionId: 'default', content: inputText.value } })
  inputText.value = ''
}

function handleStop() {
  send({ type: 'message.abort', payload: { sessionId: 'default' } })
  chatStore.setGenerating(false)
}
</script>

<style scoped>
.chat-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.panel-bar { display: flex; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--color-border); font-size: 12px; }
.panel-title { font-weight: 600; }
.chat-input-area { padding: 10px 20px 14px; border-top: 1px solid var(--color-border); background: var(--color-surface); }
.chat-textarea { width: 100%; min-height: 38px; max-height: 140px; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-base); color: var(--color-text-primary); font-family: var(--font-body); font-size: 14px; resize: none; outline: none; }
.chat-textarea:focus { border-color: var(--color-accent); }
.chat-toolbar { display: flex; gap: 4px; padding: 6px 0 0; }
.tb-btn { padding: 6px 14px; border: none; border-radius: var(--radius-sm); background: var(--color-accent); color: white; font-size: 12px; cursor: pointer; font-family: var(--font-body); }
.tb-btn:hover { opacity: 0.88; }
.tb-btn-stop { background: var(--color-danger); }
</style>
