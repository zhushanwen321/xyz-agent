<template>
  <div class="chat-input-wrap">
    <SlashMenu
      :visible="slashVisible"
      :filter="slashFilter"
      @close="closeSlashMenu"
      @select="handleSlashSelect"
    />
    <div class="chat-input-container">
      <Textarea
        v-model="text"
        :placeholder="t('chat.inputPlaceholder')"
        class="chat-input-textarea"
        :rows="1"
        no-style
        @keydown="onKeyDown"
        @compositionstart="isComposing = true"
        @compositionend="onCompositionEnd"
      />
      <div class="chat-input-toolbar">
        <Button variant="ghost" class="tb-btn tb-btn--plus" title="Upload file">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
        </Button>
        <ModelPicker :current-model="currentModel" @select="(id) => emit('select-model', id)" />
        <ContextBar :percentage="contextPercent" />
        <div class="tb-spacer"></div>
        <Button
          v-if="isStreaming"
          variant="ghost"
          class="tb-btn tb-btn--stop"
          @click="emit('cancel')"
          :title="t('chat.stop')"
        >■</Button>
        <Button
          v-else
          variant="primary"
          class="tb-btn tb-btn--send"
          :disabled="!canSend"
          @click="handleSend"
          :title="t('chat.send')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { Textarea, Button } from '../../design-system'
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
/* Wrap: positions the entire input block */
.chat-input-wrap {
  position: relative;
  margin: 0 16px 12px;
  flex-shrink: 0;
}

/* Container: single rounded card for textarea + toolbar */
.chat-input-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
  transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
  overflow: visible;
  position: relative;
  z-index: 10;
}

.chat-input-container:focus-within {
  border-color: var(--accent);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

/* Textarea: no border, transparent bg, fits inside container */
.chat-input-textarea {
  display: block;
  width: 100%;
  min-height: calc(1.45em * 2 + 16px);
  max-height: calc(1.45em * 10 + 16px);
  padding: 10px 14px 8px;
  border: none;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.45;
  resize: none;
  outline: none;
}

.chat-input-textarea::placeholder {
  color: var(--muted);
}

/* Toolbar: bottom row inside container */
.chat-input-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 6px;
}

/* Toolbar button base */
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.tb-btn:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.tb-btn svg {
  width: 14px;
  height: 14px;
}

/* Plus button */
.tb-btn--plus {
  width: 28px;
  padding: 0;
}

/* Send button */
.tb-btn--send {
  background: var(--accent);
  color: white;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
}

.tb-btn--send:disabled {
  opacity: 0.4;
  cursor: default;
}

.tb-btn--send:not(:disabled):hover {
  opacity: 0.88;
}

/* Stop button */
.tb-btn--stop {
  font-weight: 700;
  font-size: 11px;
  width: 28px;
  height: 28px;
}

.tb-btn--stop:hover {
  background: var(--danger-light);
  color: var(--danger);
}

/* Spacer */
.tb-spacer {
  flex: 1;
}
</style>
