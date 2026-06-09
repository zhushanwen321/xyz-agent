<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useProviderStore } from '../../stores/provider'
import { useChatStore } from '../../stores/chat'
import { useI18n } from 'vue-i18n'
import { Button } from '../../design-system'
import ModelPicker from './ModelPicker.vue'

const { t } = useI18n()

const props = defineProps<{
  sessionId: string
  isStreaming: boolean
  canSend: boolean
}>()

const emit = defineEmits<{
  'select-model': [payload: { modelId: string }]
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

// Pi's getSupportedThinkingLevels logic:
// - reasoning=false → only ["off"]
// - reasoning=true + thinkingLevelMap → filter by map (null=exclude, undefined=keep, xhigh needs explicit)
// - reasoning=true + no map → ["off","minimal","low","medium","high"] (all except xhigh)
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

const thinkingLevels = computed(() => {
  const model = resolvedModel.value
  if (!model) return []
  if (!model.reasoning) return []
  const map = model.thinkingLevelMap
  if (!map) {
    // No map but reasoning=true → all levels
    return [...ALL_THINKING_LEVELS]
  }
  // Normalize legacy presets: on-off missing xhigh, high-max missing off
  const normalized = { ...map }
  if (normalized.minimal === null && normalized.low === null && normalized.medium === null && normalized.high === null && !('xhigh' in normalized)) {
    normalized.xhigh = 'xhigh'
  }
  if (normalized.high === 'high' && normalized.xhigh === 'max' && !('off' in normalized)) {
    normalized.off = null
  }
  return ALL_THINKING_LEVELS.filter(level => {
    const mapped = normalized[level]
    if (mapped === null) return false
    if (level === 'xhigh') return mapped !== undefined
    return true
  })
})

// ── Magic number constants ──────────────────────────────────────
const BINARY_LEVEL_COUNT = 2
const MAX_BAR_COUNT = 7
const CONTEXT_DANGER_THRESHOLD = 85
const CONTEXT_WARN_THRESHOLD = 60
const TOKEN_K_UNIT = 1000

const showThinkingPicker = computed(() => thinkingLevels.value.length > 0)

// Show mapped value when non-identity (e.g. xhigh → 'max'), otherwise Off/On inference
function getThinkingDisplayLabel(level: string): string {
  const map = resolvedModel.value?.thinkingLevelMap
  if (map && map[level] !== undefined && map[level] !== null && map[level] !== level) {
    return map[level]
  }
  // Instant/Thinking for binary strategies
  if (thinkingLevels.value.length === BINARY_LEVEL_COUNT && thinkingLevels.value.includes('off')) {
    return level === 'off' ? t('chat.thinkingInstant') : t('chat.thinkingDeep')
  }
  return level
}

const currentThinkingLevel = computed(() => settingsStore.currentThinkingLevel)
const thinkingOpen = ref(false)
const thinkingRef = ref<HTMLElement | null>(null)

function initThinkingLevel() {
  if (thinkingLevels.value.length === 0) return
  if (thinkingLevels.value.includes(settingsStore.currentThinkingLevel as typeof ALL_THINKING_LEVELS[number])) return
  // On/off (2 levels with off): default to 'on'
  if (thinkingLevels.value.length === BINARY_LEVEL_COUNT && thinkingLevels.value.includes('off')) {
    settingsStore.currentThinkingLevel = thinkingLevels.value.find(l => l !== 'off') as typeof ALL_THINKING_LEVELS[number]
  } else {
    settingsStore.currentThinkingLevel = thinkingLevels.value[0] as typeof ALL_THINKING_LEVELS[number]
  }
}
initThinkingLevel()

// getBarColor and getBarCount replace old getBarHeights/getThinkingColor
// Bar heights are linear: 4 + i * 1.5 px, no lookup table needed

// getBarColor: active bars use accent, inactive dim
function getBarColor(level: string, barIndex: number): string {
  const levelIdx = thinkingLevels.value.indexOf(level as typeof ALL_THINKING_LEVELS[number])
  if (levelIdx < 0) return 'var(--border)'
  return barIndex <= levelIdx ? 'var(--accent)' : 'var(--border)'
}

function getBarCount(): number {
  // One bar per thinking level, max 7
  return Math.min(thinkingLevels.value.length, MAX_BAR_COUNT)
}

function pickThinking(level: string) {
  settingsStore.currentThinkingLevel = level
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
  if (pct > CONTEXT_DANGER_THRESHOLD) return 'danger'
  if (pct > CONTEXT_WARN_THRESHOLD) return 'warn'
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
const outputTokens = computed(() => Math.max(0, (sessionState.value.tokenUsage ?? 0) - inputTokens.value))

function formatTokenCount(n: number): string {
  if (n >= TOKEN_K_UNIT) return (n / TOKEN_K_UNIT).toFixed(1) + 'k'
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
  <!-- NOTE: overflow-hidden intentionally omitted — it clips ModelPicker & Thinking Picker
       dropdowns that extend upward via bottom-[calc(100%+6px)]. If toolbar items overflow
       on narrow panels, add min-width:0/shrink to the flex-right items instead. -->
  <div class="flex items-center gap-1 px-2 pb-1.5">
    <!-- Model Picker -->
    <ModelPicker :current-model="currentModel" @select="(id: string) => emit('select-model', { modelId: id })" />

    <!-- Thinking Level Picker -->
    <div v-if="showThinkingPicker" ref="thinkingRef" class="relative">
      <Button
        variant="ghost"
        class="inline-flex items-center gap-[5px] px-1.5 h-7 border-none rounded-xs bg-transparent text-fg text-[11px] font-mono cursor-pointer whitespace-nowrap transition-all duration-150 ease-ease hover:bg-accent-light hover:text-accent"
        @click="toggleThinking"
      >
        <!-- Signal bars: one bar per level, active bars colored, inactive dim -->
        <span class="inline-flex items-end gap-[1.5px] h-3">
          <span
            v-for="(_, i) in getBarCount()"
            :key="i"
            class="block w-[3px] rounded-[0.5px] transition-all duration-150 ease-ease"
            :style="{ height: (4 + i * 1.5) + 'px', background: getBarColor(currentThinkingLevel, i) }"
          ></span>
        </span>
        <span class="text-muted">{{ getThinkingDisplayLabel(currentThinkingLevel) }}</span>
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
              v-for="(_, i) in getBarCount()"
              :key="i"
              class="block w-[3px] rounded-[0.5px]"
              :style="{ height: (4 + i * 1.5) + 'px', background: getBarColor(level, i) }"
            ></span>
          </span>
          <span class="flex-1 font-mono">{{ getThinkingDisplayLabel(level) }}</span>
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
      <span>{{ Math.min(contextUsagePercent, 100).toFixed(contextUsagePercent < 1 ? 1 : 0) }}%</span>
    </span>

    <!-- Token Stats: input tokens only (total tokens not available per-request) -->
    <span class="inline-flex items-center gap-0.5 px-1 h-7 font-mono text-[10px] text-muted whitespace-nowrap">
      <span class="text-accent">&#8593;</span><span>{{ formatTokenCount(inputTokens) }}</span>
      <span class="text-muted mx-px">/</span>
      <span class="text-warning">&#8595;</span><span>{{ formatTokenCount(outputTokens) }}</span>
    </span>

    <span class="flex-1"></span>

    <!-- Stop / Send button -->
    <Button
      v-if="isStreaming"
      variant="ghost"
      class="inline-flex items-center justify-center w-7 h-7 border-none rounded-xs text-xs font-body cursor-pointer transition-all duration-150 ease-ease shrink-0 font-bold text-[11px] bg-danger text-white hover:opacity-88"
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
