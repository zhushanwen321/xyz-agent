<template>
  <div class="relative" ref="containerRef">
    <button
      type="button"
      :class="[
        'flex items-center h-5 px-2.5 text-[11px] font-mono select-none transition-colors duration-150 gap-1.5 rounded-sm',
        modeClass,
        open ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]',
      ]"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="font-medium">{{ modeLabel }}</span>
      <span class="mode-shortcut-hint opacity-50">{{ modeHint }}</span>
      <!-- chevron -->
      <svg
        class="w-3 h-3 opacity-40 transition-transform duration-150"
        :class="{ 'rotate-180': open }"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M3 4.5L6 7.5L9 4.5" />
      </svg>
    </button>

    <!-- Popover -->
    <Transition name="mode-popover">
      <div
        v-if="open"
        ref="popoverRef"
        class="absolute bottom-full left-0 mb-1 min-w-[140px] rounded-sm border shadow-lg z-50"
        style="background: var(--surface); border-color: var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.15)"
        role="listbox"
        :aria-activedescendant="`mode-option-${mode}`"
      >
        <button
          v-for="item in modes"
          :key="item.value"
          type="button"
          :id="`mode-option-${item.value}`"
          role="option"
          :aria-selected="item.value === mode"
          :class="[
            'flex items-center justify-between w-full h-7 px-2.5 text-[11px] font-mono transition-colors duration-100',
            item.value === mode ? item.activeClass : 'text-[var(--text)]',
            'hover:bg-[var(--surface-hover)]',
          ]"
          @click="selectMode(item.value)"
        >
          <span class="flex items-center gap-1.5">
            <span
              v-if="item.value === mode"
              class="text-[8px] leading-none"
            >&#9679;</span>
            <span v-else class="w-[8px] inline-block" />
            <span class="font-medium" :data-i18n="item.i18n">{{ item.label }}</span>
          </span>
          <span class="mode-shortcut-hint opacity-50">{{ item.shortcut }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

export type SendMode = 'send' | 'steer' | 'queue'

const props = defineProps<{
  mode: SendMode
  isStreaming?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:mode', mode: SendMode): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const open = ref(false)

const isMac = navigator.platform?.startsWith('Mac') ?? false

interface ModeItem {
  value: SendMode
  label: string
  shortcut: string
  activeClass: string
  i18n: string
}

const modes: ModeItem[] = [
  { value: 'send', label: 'Send', shortcut: isMac ? 'Enter' : 'Enter', activeClass: 'text-muted', i18n: 'mode.send' },
  { value: 'steer', label: 'Steer', shortcut: isMac ? 'Cmd+Enter' : 'Ctrl+Enter', activeClass: 'text-accent', i18n: 'mode.steer' },
  { value: 'queue', label: 'Follow-up', shortcut: isMac ? 'Opt+Enter' : 'Alt+Enter', activeClass: 'text-warning', i18n: 'mode.followup' },
]

const modeLabel = computed(() => {
  const item = modes.find(m => m.value === props.mode)
  return item?.label ?? 'Send'
})

const modeHint = computed(() => {
  const item = modes.find(m => m.value === props.mode)
  return item?.shortcut ?? 'Enter'
})

const modeClass = computed(() => {
  const item = modes.find(m => m.value === props.mode)
  return item?.activeClass ?? 'text-muted'
})

function toggle() {
  open.value = !open.value
}

function selectMode(value: SendMode) {
  emit('update:mode', value)
  open.value = false
}

function onClickOutside(e: MouseEvent) {
  if (!containerRef.value) return
  if (!containerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<style scoped>
.mode-popover-enter-active,
.mode-popover-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.mode-popover-enter-from,
.mode-popover-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* Container query: hide shortcut hints in narrow panels */
@container (max-width: 480px) {
  .mode-shortcut-hint {
    display: none;
  }
}
</style>
