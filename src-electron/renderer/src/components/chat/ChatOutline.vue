<template>
  <div class="chat-outline" :class="{ 'chat-outline--collapsed': !expanded }">
    <!-- Toggle button (always visible, right-aligned) -->
    <button class="chat-outline__toggle" :aria-label="expanded ? '收起目录' : '展开目录'" @click="expanded = !expanded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <!-- Outline panel (visible when expanded) -->
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
            <span class="chat-outline__dot" :class="'chat-outline__dot--' + item.dotType"></span>
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
import { ref, computed } from 'vue'
import type { ChatMessage } from '../../stores/chat'
import { isSystemNotification } from '../../stores/chat'

interface OutlineItem {
  label: string
  dotType: 'user' | 'assistant' | 'done' | 'alert' | 'warning' | 'info'
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
    // Strip /skill:xxx prefix
    const text = msg.content?.replace(/^\/skill:[^\s]+\s*/, '').trim() ?? ''
    return truncate(text, MAX_LABEL_LEN) || '用户消息'
  }
  // assistant: prefer first tool call name, or text preview
  if (msg.toolCalls?.length) {
    const first = msg.toolCalls[0]
    const name = first.toolName
    const pathObj = parseInput(first.input)
    const hint = pathObj?.path ?? pathObj?.file_path ?? pathObj?.command ?? ''
    const hintStr = String(hint)
    if (hintStr) {
      const short = hintStr.length > 20 ? hintStr.slice(0, 20) + '...' : hintStr
      return `${name} ${short}`
    }
    return name
  }
  if (msg.content) {
    return truncate(msg.content.replace(/<[^>]+>/g, '').trim(), MAX_LABEL_LEN)
  }
  if (msg.thinking?.length) {
    return 'Thinking'
  }
  return '助手'
}

function extractDotType(msg: ChatMessage): OutlineItem['dotType'] {
  if (isSystemNotification(msg)) {
    const t: string = msg.notificationType || (msg.status === 'error' ? 'alert' : 'done')
    if (t === 'alert') return 'alert'
    if (t === 'warning') return 'warning'
    if (t === 'info') return 'info'
    return 'done'
  }
  if (msg.role === 'user') return 'user'
  return 'assistant'
}

const outlineItems = computed<OutlineItem[]>(() =>
  props.messages.map(msg => ({
    label: extractLabel(msg),
    dotType: extractDotType(msg),
    messageId: msg.id,
    role: msg.role,
  })),
)

const progressLabel = computed(() => {
  const total = outlineItems.value.length
  const done = outlineItems.value.filter(i => i.dotType === 'done' || i.dotType === 'assistant').length
  return `${done}/${total}`
})

const progressPercent = computed(() => {
  const total = outlineItems.value.length
  if (total === 0) return 0
  const done = outlineItems.value.filter(i => i.dotType === 'done' || i.dotType === 'assistant').length
  return Math.round((done / total) * 100)
})

function scrollToItem(index: number, item: OutlineItem) {
  activeIndex.value = index
  emit('scroll-to-message', item.messageId)
}

function parseInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null
  try {
    return typeof input === 'string' ? JSON.parse(input) as Record<string, unknown> : input as Record<string, unknown>
  } catch { return null }
}
</script>

<style scoped>
.chat-outline {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.chat-outline__toggle {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: all 0.12s ease;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.chat-outline__toggle:hover {
  color: var(--fg);
  background: var(--hover-bg);
}

.chat-outline__panel {
  margin-top: 4px;
  width: 160px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 1px 6px rgba(0,0,0,0.04);
  overflow: hidden;
}

.chat-outline__title {
  padding: 6px 8px 4px;
  font-size: 9px;
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
  gap: 4px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 10px;
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

.chat-outline__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chat-outline__dot--user { background: var(--accent); }
.chat-outline__dot--assistant { background: var(--agent); }
.chat-outline__dot--done { background: var(--success); }
.chat-outline__dot--alert { background: var(--danger); }
.chat-outline__dot--warning { background: var(--warning); }
.chat-outline__dot--info { background: var(--agent); }

.chat-outline__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
}

.chat-outline__progress {
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.chat-outline__progress-bar {
  width: 40px;
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

/* Transition */
.outline-slide-enter-active,
.outline-slide-leave-active {
  transition: all 0.15s ease;
}
.outline-slide-enter-from,
.outline-slide-leave-to {
  opacity: 0;
  transform: translateX(8px);
}
</style>
