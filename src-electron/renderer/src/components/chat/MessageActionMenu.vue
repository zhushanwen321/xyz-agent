<template>
  <Teleport to="body">
    <!-- Backdrop to close menu -->
    <div
      v-if="visible"
      class="fixed inset-0 z-[900]"
      @click="$emit('close')"
      @contextmenu.prevent="$emit('close')"
    />
    <div
      v-if="visible"
      ref="menuRef"
      class="msg-action-menu"
      :style="menuStyle"
      tabindex="-1"
      @keydown.esc="$emit('close')"
    >
      <div class="msg-action-menu__item" @click="handleCopy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>复制</span>
      </div>
      <div class="msg-action-menu__item" @click="handleCopyPlain">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>复制纯文本</span>
      </div>
      <div class="msg-action-menu__divider" />
      <div class="msg-action-menu__item" @click="handleNavigate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        <span>Navigate</span>
      </div>
      <div class="msg-action-menu__item" @click="handleFork">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        <span>Fork</span>
      </div>
      <div class="msg-action-menu__item" @click="handleClone">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>Clone</span>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { collectMessageContent } from '../../lib/collectMessageContent'
import { copyWithToast } from '../../lib/clipboard'
import { emit as emitEvent } from '../../lib/event-bus'
import { useTree } from '../../composables/useTree'

const props = defineProps<{
  entryId: string
  sessionId: string
  message: Message
  format: 'markdown' | 'plain'
  visible: boolean
  /** Position anchor: the button that triggered this menu */
  anchorRect?: DOMRect | null
}>()

const emit = defineEmits<{
  close: []
  navigate: [targetEntryId: string]
}>()

const { fork, cloneSession } = useTree()

const menuRef = ref<HTMLElement | null>(null)

const menuStyle = computed(() => {
  if (!props.anchorRect) return {}
  const MENU_WIDTH = 180
  const MENU_OFFSET_Y = 4
  const x = props.anchorRect.left
  const y = props.anchorRect.bottom + MENU_OFFSET_Y
  return {
    left: `${x}px`,
    top: `${y}px`,
    minWidth: `${MENU_WIDTH}px`,
  }
})

function getMessageEl(): HTMLElement | null {
  // Find the closest message wrapper from the anchor
  if (!props.anchorRect) return null
  // Use entryId to find the message element
  return document.querySelector(`[data-entry-id="${props.entryId}"]`)
    ?? document.querySelector(`[data-message-id="${props.message.id}"]`)
    ?? null
}

async function handleCopy() {
  const el = getMessageEl()
  if (!el) {
    console.warn('[MessageActionMenu] message element not found for entryId:', props.entryId)
    emitEvent('toast:show', {
      type: 'danger',
      title: '无法复制',
      description: '消息已不在视图中',
    })
    emit('close')
    return
  }
  const text = collectMessageContent(el, { format: 'markdown' })
  await copyWithToast(text, { format: 'markdown' })
  emit('close')
}

async function handleCopyPlain() {
  const el = getMessageEl()
  if (!el) {
    console.warn('[MessageActionMenu] message element not found for entryId:', props.entryId)
    emitEvent('toast:show', {
      type: 'danger',
      title: '无法复制',
      description: '消息已不在视图中',
    })
    emit('close')
    return
  }
  const text = collectMessageContent(el, { format: 'plain' })
  await copyWithToast(text, { format: 'plain' })
  emit('close')
}

function handleNavigate() {
  emit('navigate', props.entryId)
  emit('close')
}

function handleFork() {
  if (props.sessionId && props.entryId) {
    fork(props.sessionId, props.entryId)
  }
  emit('close')
}

function handleClone() {
  if (props.sessionId) {
    cloneSession(props.sessionId)
  }
  emit('close')
}

// Close on Escape (both document-level fallback and keydown.esc on the menu root)
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    emit('close')
  }
}

// Focus menu on open so Esc inside it works
watch(() => props.visible, (val) => {
  if (val) {
    nextTick(() => {
      menuRef.value?.focus()
    })
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.msg-action-menu {
  position: fixed;
  z-index: 901;
  min-width: 180px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
}
.msg-action-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s ease;
}
.msg-action-menu__item:hover {
  background: var(--accent-light);
  color: var(--accent);
}
.msg-action-menu__divider {
  margin: 4px 8px;
  border-top: 1px solid var(--border);
}
</style>
