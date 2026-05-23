<template>
  <div ref="overviewRef" class="fixed inset-0 z-[100] bg-[oklch(15%_0.02_50_/_0.65)] backdrop-blur-[20px] flex flex-col items-center justify-center opacity-0 pointer-events-none transition-opacity duration-[250ms] ease-ease" :class="{ 'opacity-100 pointer-events-auto': visible }" tabindex="0" @click.self="emit('close')">
    <div class="font-display text-lg font-semibold text-[oklch(95%_0_0)] mb-7 tracking-[-0.01em]">窗口总览</div>
    <div class="grid grid-cols-3 gap-5 max-w-[960px] px-8 w-full">
      <WindowCard
        v-for="(win, idx) in windowCards"
        :key="win.windowId"
        :window-state="win"
        :highlighted="highlightedIdx === idx"
        :style="{ transitionDelay: visible ? `${idx * 0.03}s` : '0s' }"
        @select="handleSelect(idx)"
      />
    </div>
    <div class="mt-6 flex justify-center">
      <!-- eslint-disable-next-line taste/no-native-html-elements -->
      <button class="inline-flex items-center gap-1.5 py-2 px-5 border border-[oklch(60%_0_0_/_0.3)] rounded-sm bg-transparent text-[oklch(80%_0_0_/_0.8)] text-[13px] font-medium font-body cursor-pointer transition-all duration-200 ease-ease hover:bg-[oklch(30%_0_0_/_0.4)] hover:text-[oklch(95%_0_0)] hover:border-[oklch(80%_0_0_/_0.5)]" @click="handleNewWindow">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New Window
      </button>
    </div>
    <div class="mt-7 text-xs text-[oklch(70%_0_0_/_0.7)] flex gap-5">
      <span><kbd class="inline-flex items-center py-[2px] px-1.5 bg-[oklch(30%_0_0_/_0.5)] rounded-sm font-mono text-[11px] text-[oklch(85%_0_0)] mx-[3px]">Enter</kbd> 聚焦窗口</span>
      <span><kbd class="inline-flex items-center py-[2px] px-1.5 bg-[oklch(30%_0_0_/_0.5)] rounded-sm font-mono text-[11px] text-[oklch(85%_0_0)] mx-[3px]">&larr;</kbd><kbd class="inline-flex items-center py-[2px] px-1.5 bg-[oklch(30%_0_0_/_0.5)] rounded-sm font-mono text-[11px] text-[oklch(85%_0_0)] mx-[3px]">&rarr;</kbd> 选择</span>
      <span><kbd class="inline-flex items-center py-[2px] px-1.5 bg-[oklch(30%_0_0_/_0.5)] rounded-sm font-mono text-[11px] text-[oklch(85%_0_0)] mx-[3px]">Esc</kbd> 返回</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useWindowStore } from '../../stores/window'
import WindowCard from './WindowCard.vue'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const windowStore = useWindowStore()

const windowCards = computed(() => windowStore.windows)

const highlightedIdx = ref(0)
const overviewRef = ref<HTMLElement | null>(null)

// Auto-focus when visible for keyboard events
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      highlightedIdx.value = 0
      windowStore.refreshFromIPC()
      await nextTick()
      overviewRef.value?.focus()
    }
  },
)

// Use capture phase to intercept keys before other document listeners
function onDocumentKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  const len = windowCards.value.length
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
      handleSelect(highlightedIdx.value)
      break
    }
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      emit('close')
      break
  }
}

function handleSelect(idx: number) {
  const card = windowCards.value[idx]
  if (!card) return
  windowStore.focusWindow(card.windowId)
  emit('close')
}

async function handleNewWindow() {
  await windowStore.createWindow()
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown, true)
  windowStore.refreshFromIPC()
})
onUnmounted(() => {
  document.removeEventListener('keydown', onDocumentKeydown, true)
})

// Clamp highlighted index when cards array changes
watch(
  () => windowCards.value.length,
  (len) => {
    if (len === 0) return
    if (highlightedIdx.value >= len) {
      highlightedIdx.value = len - 1
    }
  },
)
</script>
