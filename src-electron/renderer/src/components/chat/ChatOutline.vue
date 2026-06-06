<template>
  <div class="chat-outline" @keydown.escape="onEsc">
    <!-- Toggle button (always visible, same style as scroll-fab) -->
    <button
      class="chat-outline__toggle"
      :class="{ 'chat-outline__toggle--active': expanded }"
      :aria-label="expanded ? '收起目录' : '展开目录'"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <!-- Outline panel (slides left from button) -->
    <Transition name="outline-slide">
      <div v-if="expanded" class="chat-outline__panel">
        <div class="chat-outline__title">目录</div>
        <div class="chat-outline__items">
          <button
            v-for="(item, i) in outlineItems"
            :key="i"
            :class="['chat-outline__item', { 'chat-outline__item--active': activeIndex === i }]"
            @click="scrollToItem(i, item)"
          >
            <span class="chat-outline__role" :class="'chat-outline__role--' + item.role">{{ item.role === 'user' ? 'U' : 'A' }}</span>
            <span class="chat-outline__label">{{ item.label }}</span>
          </button>
        </div>
        <!-- Progress -->
        <div v-if="outlineItems.length > 0" class="chat-outline__progress">
          <span>{{ progressLabel }}</span>
          <div class="chat-outline__progress-bar">
            <div class="chat-outline__progress-fill" :style="{ width: progressPercent + '%' }"></div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { ChatMessage } from '../../stores/chat'
import { isSystemNotification } from '../../stores/chat'

interface OutlineItem {
  label: string
  messageId: string
  role: string
}

const props = defineProps<{
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  'scroll-to-message': [messageId: string]
}>()

const expanded = ref(false)
const activeIndex = ref(-1)

const MAX_LABEL_LEN = 28

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '...'
}

function extractLabel(msg: ChatMessage): string {
  if (isSystemNotification(msg)) {
    return msg.notificationTitle || truncate(msg.content ?? '', MAX_LABEL_LEN) || '通知'
  }
  if (msg.role === 'user') {
    const text = msg.content?.replace(/^\/skill:[^\s]+\s*/, '').trim() ?? ''
    return truncate(text, MAX_LABEL_LEN) || '用户消息'
  }
  // assistant: prefer text content, fallback to tool call name
  if (msg.content) {
    return truncate(msg.content.replace(/<[^>]+>/g, '').trim(), MAX_LABEL_LEN) || '助手'
  }
  if (msg.toolCalls?.length) {
    const first = msg.toolCalls[0]
    return first.toolName
  }
  if (msg.thinking?.length) {
    return 'Thinking'
  }
  return '助手'
}

const outlineItems = computed<OutlineItem[]>(() =>
  props.messages
    .filter(msg => {
      // Hide pure tool-call messages (no text content)
      if (msg.role === 'assistant' && !msg.content && msg.toolCalls?.length) return false
      // Hide thinking-only messages
      if (msg.role === 'assistant' && !msg.content && !msg.toolCalls?.length && msg.thinking?.length) return false
      return true
    })
    .map(msg => ({
      label: extractLabel(msg),
      messageId: msg.id,
      role: msg.role,
    })),
)

const progressLabel = computed(() => {
  const total = outlineItems.value.length
  return `${total} 条`
})

const progressPercent = computed(() => {
  const total = outlineItems.value.length
  if (total === 0) return 0
  const users = outlineItems.value.filter(i => i.role === 'user').length
  return Math.round((users / total) * 100)
})

function toggle() {
  expanded.value = !expanded.value
}

function onEsc() {
  if (expanded.value) {
    expanded.value = false
  }
}

function scrollToItem(index: number, item: OutlineItem) {
  activeIndex.value = index
  emit('scroll-to-message', item.messageId)
}



// Global ESC listener (component may not have focus)
function globalEscHandler(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) {
    expanded.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', globalEscHandler)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', globalEscHandler)
})
</script>

<style scoped>
.chat-outline {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* Same visual style as scroll-fab */
.chat-outline__toggle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  transition: all 0.2s ease;
}
.chat-outline__toggle:hover {
  color: var(--fg);
  box-shadow: var(--shadow-md);
  border-color: var(--muted);
}
.chat-outline__toggle--active {
  color: var(--fg);
  background: var(--hover-bg);
}

/* Panel: positioned to the left of the button */
.chat-outline__panel {
  position: absolute;
  top: 0;
  right: 100%;
  margin-right: 8px;
  width: 180px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.chat-outline__title {
  padding: 8px 10px 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}

.chat-outline__items {
  max-height: 320px;
  overflow-y: auto;
}

.chat-outline__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
  border-left: 2px solid transparent;
  transition: all 0.1s ease;
  text-align: left;
}
.chat-outline__item:hover { background: var(--hover-bg); }
.chat-outline__item--active {
  color: var(--fg);
  border-left-color: var(--accent);
  background: var(--hover-bg);
}

.chat-outline__role {
  width: 16px;
  height: 16px;
  border-radius: 2px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  font-family: var(--font-mono);
}
.chat-outline__role--user {
  background: var(--accent);
  color: var(--surface);
}
.chat-outline__role--assistant {
  background: var(--agent);
  color: var(--surface);
}
.chat-outline__role--system {
  background: var(--success);
  color: var(--surface);
}

.chat-outline__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
}

.chat-outline__progress {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.chat-outline__progress-bar {
  width: 48px;
  height: 3px;
  background: var(--border);
  border-radius: 1px;
  overflow: hidden;
}
.chat-outline__progress-fill {
  height: 100%;
  background: var(--success);
  border-radius: 1px;
  transition: width 0.3s ease;
}

/* Slide-in from right */
.outline-slide-enter-active,
.outline-slide-leave-active {
  transition: all 0.15s ease;
}
.outline-slide-enter-from,
.outline-slide-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
