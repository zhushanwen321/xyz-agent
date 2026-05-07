<template>
  <div class="chat-input">
    <div class="chat-input__field">
      <textarea
        ref="textareaRef"
        v-model="text"
        :placeholder="t('chat.inputPlaceholder')"
        class="chat-input__textarea"
        rows="1"
        @input="onInput"
        @keydown="onKeyDown"
        @compositionstart="isComposing = true"
        @compositionend="onCompositionEnd"
      ></textarea>
      <button
        v-if="isStreaming"
        class="chat-input__btn chat-input__btn--stop"
        @click="emit('cancel')"
        :title="t('chat.stop')"
      >
        <span class="chat-input__btn-icon">■</span>
      </button>
      <button
        v-else
        class="chat-input__btn chat-input__btn--send"
        :disabled="!canSend"
        @click="handleSend"
        :title="t('chat.send')"
      >
        <span class="chat-input__btn-icon">↑</span>
      </button>
    </div>
    <div class="chat-input__toolbar">
      <button class="chat-input__tool-btn" :title="'Upload file'">📎</button>
      <div class="chat-input__spacer"></div>
      <ContextBar :percentage="contextPercent" />
      <ModelPicker :current-model="currentModel" @select="(id) => emit('select-model', id)" />
    </div>
    <SlashMenu
      :visible="slashVisible"
      :filter="slashFilter"
      @close="closeSlashMenu"
      @select="handleSlashSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import ContextBar from './ContextBar.vue'
import ModelPicker from './ModelPicker.vue'
import SlashMenu from './SlashMenu.vue'

const props = defineProps<{ isStreaming: boolean }>()
const emit = defineEmits<{
  send: [content: string]
  cancel: []
  'select-model': [modelId: string]
}>()

const { t } = useI18n()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

const text = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const isComposing = ref(false)

const contextPercent = computed(() => chatStore.contextUsagePercent)
const currentModel = computed(() => settingsStore.defaultModel)

const canSend = computed(() => text.value.trim().length > 0 && !props.isStreaming)

// Slash command state
const slashVisible = ref(false)
const slashFilter = ref('')

watch(text, (val) => {
  if (val.startsWith('/')) {
    slashVisible.value = true
    slashFilter.value = val.slice(1)
  } else {
    slashVisible.value = false
    slashFilter.value = ''
  }
})

function closeSlashMenu() {
  slashVisible.value = false
}

function handleSlashSelect(name: string) {
  text.value = ''
  slashVisible.value = false
  // Execute command via emit — parent can handle, or we emit the full /command
  emit('send', `/${name}`)
}

function handleSend() {
  if (!canSend.value) return
  emit('send', text.value.trim())
  text.value = ''
  slashVisible.value = false
  nextTick(resizeTextarea)
}

function onKeyDown(e: KeyboardEvent) {
  // If slash menu is open, let it handle navigation keys
  if (slashVisible.value && ['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) {
    return // SlashMenu handles these via document-level listener
  }

  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value) {
    e.preventDefault()
    if (slashVisible.value) return // let SlashMenu handle Enter
    handleSend()
  }
}

function onCompositionEnd() {
  isComposing.value = false
}

function onInput() {
  nextTick(resizeTextarea)
}

const MAX_HEIGHT = 140

function resizeTextarea() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px'
}

// Reset height when text is cleared
watch(text, () => nextTick(resizeTextarea))
</script>

<style scoped>
.chat-input {
  padding: 10px 20px 14px;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}

.chat-input__field {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.chat-input__textarea {
  flex: 1;
  min-height: 38px;
  max-height: 140px;
  padding: 8px 12px;
  padding-right: 40px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-base);
  color: var(--color-text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  outline: none;
}

.chat-input__textarea:focus {
  border-color: var(--color-accent);
}

.chat-input__btn {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
}

.chat-input__btn--send {
  background: var(--color-accent);
  color: white;
}

.chat-input__btn--send:disabled {
  opacity: 0.4;
  cursor: default;
}

.chat-input__btn--send:not(:disabled):hover {
  opacity: 0.88;
}

.chat-input__btn--stop {
  background: var(--color-danger);
  color: white;
}

.chat-input__btn--stop:hover {
  opacity: 0.88;
}

.chat-input__btn-icon {
  font-size: 14px;
  line-height: 1;
}

.chat-input__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
}

.chat-input__tool-btn {
  padding: 2px 4px;
  border: none;
  background: none;
  font-size: 14px;
  cursor: pointer;
  opacity: 0.5;
  border-radius: var(--radius-sm);
}

.chat-input__tool-btn:hover {
  opacity: 0.8;
  background: var(--color-bg-base);
}

.chat-input__spacer {
  flex: 1;
}
</style>
