<template>
  <div ref="overviewRef" class="overview" :class="{ visible }" tabindex="0">
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
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

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

// Use capture phase to intercept keys before other document listeners
function onDocumentKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  // Always intercept keys when overview is showing
  const len = props.cards.length
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault()
      e.stopPropagation()
      if (len > 0) highlightedIdx.value = (highlightedIdx.value - 1 + len) % len
      break
    case 'ArrowRight':
      e.preventDefault()
      e.stopPropagation()
      if (len > 0) highlightedIdx.value = (highlightedIdx.value + 1) % len
      break
    case 'Enter': {
      e.preventDefault()
      e.stopPropagation()
      const card = props.cards[highlightedIdx.value]
      if (card) {
        if (e.shiftKey) emit('enter-split', card.id)
        else emit('enter', card.id)
      }
      break
    }
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      emit('close')
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown, true) // capture phase
})
onUnmounted(() => {
  document.removeEventListener('keydown', onDocumentKeydown, true)
})

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
</script>

<style scoped>
/* All styles defined in global CSS (style.css) */
</style>
