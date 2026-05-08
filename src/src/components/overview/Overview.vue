<template>
  <div ref="overviewRef" class="overview" :class="{ visible }" @keydown="onKeyDown" tabindex="0">
    <div class="overview__title">窗口总览</div>
    <div class="overview__grid">
      <div
        v-for="(card, idx) in cards"
        :key="card.id"
        :class="['overview__card', { highlighted: highlightedIdx === idx }]"
        :style="{ transitionDelay: visible ? `${idx * 0.03}s` : '0s' }"
        @click="$emit('enter', card.id)"
        @dblclick="$emit('enter-split', card.id)"
      >
        <div class="card__preview">
          <div
            v-for="(line, li) in card.previewLines"
            :key="li"
            :class="[
              'card__preview__line',
              { 'card__preview__line--user': line.isUser, 'card__preview__line--bot': !line.isUser }
            ]"
          >
            {{ line.text }}
          </div>
        </div>
        <div class="card__footer">
          <div class="card__title">
            {{ card.title }}
            <span :class="['card__badge', `card__badge--${card.status}`]">
              <span class="card__badge__dot"></span>
              {{ statusLabels[card.status] || card.status }}
            </span>
          </div>
          <div class="card__project">{{ card.project }}</div>
          <div class="card__meta">
            <span v-for="m in card.meta" :key="m.label" class="card__meta-item">
              {{ m.label }}: {{ m.value }}
            </span>
          </div>
        </div>
      </div>
    </div>
    <div class="overview__hint">
      <span><kbd>Enter</kbd> 进入</span>
      <span><kbd>Shift</kbd>+<kbd>Enter</kbd> 分屏进入</span>
      <span><kbd>&larr;</kbd> <kbd>&rarr;</kbd> 选择</span>
      <span><kbd>Esc</kbd> 返回</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

interface PreviewLine {
  text: string
  isUser: boolean
}

interface MetaItem {
  label: string
  value: string
}

export interface OverviewCard {
  id: string
  title: string
  project: string
  status: 'run' | 'pause' | 'idle'
  previewLines: PreviewLine[]
  meta: MetaItem[]
}

const props = defineProps<{
  visible: boolean
  cards: OverviewCard[]
}>()

const emit = defineEmits<{
  enter: [id: string]
  'enter-split': [id: string]
  close: []
}>()

const statusLabels: Record<string, string> = {
  run: '运行中',
  pause: '暂停',
  idle: '闲置',
}

const highlightedIdx = ref(0)
const overviewRef = ref<HTMLElement | null>(null)

// Auto-focus when visible for keyboard events
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick()
      overviewRef.value?.focus()
    }
  },
)

// Clamp highlighted index when cards array changes
watch(
  () => props.cards.length,
  (len) => {
    if (len === 0) return
    if (highlightedIdx.value >= len) {
      highlightedIdx.value = len - 1
    }
  }
)

function onKeyDown(e: KeyboardEvent) {
  const len = props.cards.length
  if (len === 0) return

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault()
      highlightedIdx.value = (highlightedIdx.value - 1 + len) % len
      break
    case 'ArrowRight':
      e.preventDefault()
      highlightedIdx.value = (highlightedIdx.value + 1) % len
      break
    case 'Enter': {
      e.preventDefault()
      const card = props.cards[highlightedIdx.value]
      if (!card) break
      if (e.shiftKey) {
        emit('enter-split', card.id)
      } else {
        emit('enter', card.id)
      }
      break
    }
    case 'Escape':
      e.preventDefault()
      emit('close')
      break
  }
}
</script>

<style scoped>
.overview {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: oklch(15% 0.02 50/0.65);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s var(--ease);
}

.overview.visible {
  opacity: 1;
  pointer-events: auto;
}

.overview__title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  color: oklch(95% 0 0);
  margin-bottom: 28px;
}

.overview__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  max-width: 960px;
  padding: 0 32px;
  width: 100%;
}

.overview__card {
  background: var(--surface);
  border: 2px solid transparent;
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s var(--ease);
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.overview.visible .overview__card {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.overview__card:hover {
  border-color: var(--accent);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
}

.overview__card.highlighted {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px oklch(64% 0.13 28/0.4);
}

.card__preview {
  height: 110px;
  background: var(--bg);
  padding: 10px 12px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--muted);
  overflow: hidden;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
}

.card__preview__line {
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card__preview__line--user {
  color: var(--accent);
  font-weight: 600;
}

.card__preview__line--bot {
  color: var(--fg);
  opacity: 0.7;
}

.card__footer {
  padding: 10px 12px;
}

.card__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.card__project {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 6px;
}

.card__meta {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--muted);
  flex-wrap: wrap;
}

.card__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.card__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 8px;
}

.card__badge--run {
  background: var(--success-light);
  color: var(--success);
}

.card__badge--pause {
  background: var(--warning-light);
  color: var(--warning);
}

.card__badge--idle {
  background: var(--border);
  color: var(--muted);
}

.card__badge__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.overview__hint {
  margin-top: 28px;
  font-size: 12px;
  color: oklch(70% 0 0/0.7);
  display: flex;
  gap: 20px;
}

.overview__hint kbd {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: oklch(30% 0 0/0.5);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: oklch(85% 0 0);
  margin: 0 3px;
}
</style>
