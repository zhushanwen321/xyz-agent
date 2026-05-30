<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useProviderStore } from '../../stores/provider'
import { useChatStore } from '../../stores/chat'
import { Button } from '../../design-system'
import ModelPicker from './ModelPicker.vue'

const props = defineProps<{
  sessionId: string
  isStreaming: boolean
  canSend: boolean
}>()

const emit = defineEmits<{
  'select-model': [modelId: string]
  'select-thinking-level': [level: string]
  send: []
  cancel: []
}>()

const settingsStore = useSettingsStore()
const providerStore = useProviderStore()
const chatStore = useChatStore()

// ── Model ──────────────────────────────────────────────────────

const currentModel = computed(() => settingsStore.defaultModel)

// ── Thinking Level ─────────────────────────────────────────────

const resolvedModel = computed(() => {
  const models = providerStore.models
  if (!currentModel.value) return models[0]
  return models.find(m => m.id === currentModel.value || m.id === currentModel.value.split('/').pop()) ?? models[0]
})

const thinkingLevelMap = computed(() => resolvedModel.value?.thinkingLevelMap)
const thinkingLevels = computed(() => Object.keys(thinkingLevelMap.value ?? {}))
const showThinkingPicker = computed(() => thinkingLevels.value.length > 0)

const currentThinkingLevel = ref('')
const thinkingOpen = ref(false)
const thinkingRef = ref<HTMLElement | null>(null)

// Initialize thinking level when model changes
function initThinkingLevel() {
  if (thinkingLevels.value.length > 0 && !thinkingLevels.value.includes(currentThinkingLevel.value)) {
    currentThinkingLevel.value = thinkingLevels.value[0]
  }
}
initThinkingLevel()

const THINKING_BAR_HEIGHTS: Record<string, number[]> = {
  off: [3, 3, 3, 3, 3],
  minimal: [2, 4, 5, 6, 7],
  low: [2, 4, 6, 8, 9],
  medium: [2, 5, 7, 9, 10],
  high: [2, 5, 8, 10, 11],
  xhigh: [3, 6, 9, 11, 12],
}

function getBarHeights(level: string): number[] {
  if (THINKING_BAR_HEIGHTS[level]) return THINKING_BAR_HEIGHTS[level]
  const idx = thinkingLevels.value.indexOf(level)
  const step = 2.4
  return Array.from({ length: 5 }, (_, i) => Math.round(2 + (idx + 1) * step * (i / 4)))
}

function getThinkingColor(level: string): string {
  const colors = ['var(--muted)', 'var(--accent)', 'var(--success)', 'var(--warning)', 'var(--danger)']
  const idx = thinkingLevels.value.indexOf(level)
  return colors[Math.min(idx, colors.length - 1)]
}

function pickThinking(level: string) {
  currentThinkingLevel.value = level
  thinkingOpen.value = false
  emit('select-thinking-level', level)
}

function toggleThinking() {
  thinkingOpen.value = !thinkingOpen.value
}

// ── Context Bar ────────────────────────────────────────────────

const sessionState = computed(() => chatStore.getSessionState(props.sessionId))

const contextUsagePercent = computed(() => sessionState.value.contextUsagePercent ?? 0)

const contextSeverity = computed<'ok' | 'warn' | 'danger'>(() => {
  const pct = contextUsagePercent.value
  if (pct > 85) return 'danger'
  if (pct > 60) return 'warn'
  return 'ok'
})

const contextColor = computed(() => {
  switch (contextSeverity.value) {
    case 'danger': return 'var(--danger)'
    case 'warn': return 'var(--warning)'
    default: return 'var(--accent)'
  }
})

// ── Token Stats ────────────────────────────────────────────────

const inputTokens = computed(() => sessionState.value.contextInputTokens ?? 0)

function formatTokenCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// ── Click outside for thinking dropdown ────────────────────────

function onClickOutside(e: MouseEvent) {
  if (thinkingRef.value && !thinkingRef.value.contains(e.target as Node)) {
    thinkingOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
})
</script>

<template>
  <div class="flex items-center gap-1 px-2 pb-1.5">
    <!-- Model Picker -->
    <ModelPicker :current-model="currentModel" @select="(id: string) => emit('select-model', id)" />

    <!-- Thinking Level Picker -->
    <div v-if="showThinkingPicker" ref="thinkingRef" class="relative">
      <Button
        variant="ghost"
        class="inline-flex items-center gap-[5px] px-1.5 h-7 border-none rounded-xs bg-transparent text-fg text-[11px] font-mono cursor-pointer whitespace-nowrap transition-all duration-150 ease-ease hover:bg-accent-light hover:text-accent"
        @click="toggleThinking"
      >
        <!-- Signal bars SVG -->
        <span class="inline-flex items-end gap-[1.5px] h-3">
          <span
            v-for="(h, i) in getBarHeights(currentThinkingLevel)"
            :key="i"
            class="block w-[3px] rounded-[0.5px] transition-all duration-150 ease-ease"
            :style="{ height: h + 'px', background: getThinkingColor(currentThinkingLevel) }"
          ></span>
        </span>
        <span :style="{ color: getThinkingColor(currentThinkingLevel) }">{{ currentThinkingLevel }}</span>
      </Button>
      <!-- Thinking dropdown -->
      <div
        v-if="thinkingOpen"
        class="absolute bottom-[calc(100%+6px)] left-0 min-w-[200px] max-h-[280px] bg-surface border border-border rounded-sm shadow-lg z-[200] overflow-y-auto"
      >
        <Button
          v-for="level in thinkingLevels"
          :key="level"
          variant="ghost"
          :class="[
            'flex items-center gap-2.5 w-full py-2 px-3 border-none bg-transparent text-fg text-xs text-left cursor-pointer transition-colors duration-100 ease-ease hover:bg-accent-light',
            level === currentThinkingLevel && 'text-accent font-semibold',
          ]"
          @click="pickThinking(level)"
        >
          <span class="inline-flex items-end gap-[1.5px] h-3">
            <span
              v-for="(h, i) in getBarHeights(level)"
              :key="i"
              class="block w-[3px] rounded-[0.5px]"
              :style="{ height: h + 'px', background: getThinkingColor(level) }"
            ></span>
          </span>
          <span class="flex-1 font-mono">{{ level }}</span>
          <span v-if="level === currentThinkingLevel" class="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0 text-accent">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 6.5 11.5 13 4.5" /></svg>
          </span>
        </Button>
      </div>
    </div>

    <!-- Context Bar -->
    <span class="inline-flex items-center gap-1 px-1.5 h-7 text-[11px] font-mono text-muted shrink-0">
      <span class="w-10 h-1 bg-border rounded-sm overflow-hidden">
        <span
          class="block h-full rounded-sm transition-all duration-300 ease-ease"
          :style="{ width: Math.min(contextUsagePercent, 100) + '%', background: contextColor }"
        ></span>
      </span>
      <span>{{ Math.min(contextUsagePercent, 100) }}%</span>
    </span>

    <!-- Token Stats: input tokens only (total tokens not available per-request) -->
    <span class="inline-flex items-center gap-0.5 px-1 h-7 font-mono text-[10px] text-muted whitespace-nowrap">
      <span class="text-accent">&#8593;</span><span>{{ formatTokenCount(inputTokens) }}</span>
    </span>

    <span class="flex-1"></span>

    <!-- Stop / Send button -->
    <Button
      v-if="isStreaming"
      variant="ghost"
      class="inline-flex items-center justify-center w-7 h-7 border-none rounded-xs bg-transparent text-muted text-xs font-body cursor-pointer transition-all duration-150 ease-ease shrink-0 font-bold text-[11px] hover:bg-danger-light hover:text-danger"
      @click="emit('cancel')"
      title="Stop"
    >&#9632;</Button>
    <Button
      v-else
      variant="primary"
      class="w-7 h-7 rounded-xs disabled:opacity-40 disabled:cursor-default hover:opacity-88 bg-accent text-white"
      :disabled="!canSend"
      @click="emit('send')"
      title="Send"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4" /></svg>
    </Button>
  </div>
</template>
