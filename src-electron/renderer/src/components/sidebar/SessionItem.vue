<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import { useI18n } from 'vue-i18n'
import { Input } from '../../design-system'

const props = defineProps<{
  session: SessionSummary & { doneCount?: number; alertCount?: number }
  isActive: boolean
  renaming?: boolean
}>()

const emit = defineEmits<{
  click: []
  rename: [sessionId: string]
  'confirm-rename': [sessionId: string, newName: string]
  'cancel-rename': []
  delete: [sessionId: string]
}>()

const { t } = useI18n()

const renameInput = ref<{ focus: () => void } | null>(null)
const renameValue = ref('')
const confirmDelete = ref(false)

const renameBtn: Record<string, ((e: Event) => void) | string | undefined> = {
  type: 'button',
  class: 'inline-flex items-center justify-center w-[22px] h-[22px] rounded-xs text-muted cursor-pointer shrink-0 opacity-0 transition-all duration-150 ease-ease group-hover:opacity-100 hover:bg-accent-light hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 bg-transparent border-none',
  title: 'Rename',
  onClick: (e: Event) => startRename(e as MouseEvent),
  onKeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') startRename(e as MouseEvent) },
}
const deleteBtn: Record<string, ((e: Event) => void) | string | undefined> = {
  type: 'button',
  class: 'inline-flex items-center justify-center w-[22px] h-[22px] rounded-xs text-muted cursor-pointer shrink-0 opacity-0 transition-all duration-150 ease-ease group-hover:opacity-100 hover:bg-accent-light hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 bg-transparent border-none',
  title: 'Delete',
  onClick: (e: Event) => startDelete(e as MouseEvent),
  onKeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') startDelete(e as MouseEvent) },
}
const confirmDelBtn: Record<string, ((e: Event) => void) | string | undefined> = {
  type: 'button',
  class: 'inline-flex items-center justify-center px-2 h-[22px] rounded-xs text-[11px] font-semibold bg-danger text-white cursor-pointer shrink-0 hover:opacity-[0.88] focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 border-none',
  onClick: (e: Event) => confirmDeleteAction(e as MouseEvent),
  onKeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') confirmDeleteAction(e as MouseEvent) },
  onMouseleave: () => cancelDelete(),
}

const dotClass = computed(() => {
  switch (props.session.status) {
    case 'active': return 'w-[7px] h-[7px] rounded-full shrink-0 bg-success'
    default: return 'w-[7px] h-[7px] rounded-full shrink-0 bg-border'
  }
})

const hasNotif = computed(() =>
  (props.session.doneCount ?? 0) > 0 || (props.session.alertCount ?? 0) > 0
)

const relativeTime = computed(() => {
  const diff = Date.now() - props.session.lastActiveAt
  const seconds = Math.floor(diff / MS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return t('sidebar.justNow')
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return t('sidebar.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return t('sidebar.hoursAgo', { n: hours })
  const days = Math.floor(hours / HOURS_PER_DAY)
  return t('sidebar.daysAgo', { n: days })
})

function startRename(e: MouseEvent) {
  e.stopPropagation()
  renameValue.value = props.session.label
  emit('rename', props.session.id)
  nextTick(() => {
    renameInput.value?.focus()
  })
}

function confirmRename() {
  const name = renameValue.value.trim()
  if (name && name !== props.session.label) {
    // eslint-disable-next-line taste/no-multi-arg-emit
    emit('confirm-rename', props.session.id, name)
  } else {
    emit('cancel-rename')
  }
}

function cancelRename() {
  emit('cancel-rename')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') emit('click')
}

function startDelete(e: MouseEvent) {
  e.stopPropagation()
  confirmDelete.value = true
}

function confirmDeleteAction(e: MouseEvent) {
  e.stopPropagation()
  confirmDelete.value = false
  emit('delete', props.session.id)
}

function cancelDelete() {
  confirmDelete.value = false
}

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
</script>

<template>
  <div
    :class="[
      'group flex items-center gap-2 py-[7px] pl-6 pr-3.5 cursor-pointer border-l-[3px] border-transparent select-none transition-colors duration-150 ease-ease hover:bg-accent-light focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 rounded-sm',
      { 'border-l-0 bg-accent-light': isActive, 'font-semibold': hasNotif, 'pr-3.5': renaming }
    ]"
    role="button"
    tabindex="0"
    @click="!renaming && emit('click')"
    @keydown="onKeydown"
  >
    <span :class="dotClass" />
    <!-- Renaming mode: inline input -->
    <template v-if="renaming">
      <Input
        ref="renameInput"
        v-model="renameValue"
        class="flex-1 text-[13px] leading-none bg-bg border border-accent rounded-xs py-[3px] px-[6px] h-auto outline-none text-fg"
        @keydown.enter="confirmRename"
        @keydown.escape="cancelRename"
        @blur="confirmRename"
        @click.stop
      />
    </template>
    <!-- Normal mode: label + actions -->
    <template v-else>
      <span class="flex-1 text-[13px] whitespace-nowrap overflow-hidden text-ellipsis">{{ session.label }}</span>
      <span v-if="(session.doneCount ?? 0) > 0" class="inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[9px] font-bold text-white ml-1 shrink-0 bg-success">{{ session.doneCount }}</span>
      <span v-if="(session.alertCount ?? 0) > 0" class="inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[9px] font-bold text-white ml-1 shrink-0 bg-danger">{{ session.alertCount }}</span>
      <span class="text-[11px] text-muted whitespace-nowrap flex items-center gap-1">{{ relativeTime }}</span>
      <!-- Rename button -->
      <button v-bind="renameBtn">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5a2.121 2.121 0 013 3L5 14l-4 1 1-4z"/></svg>
      </button>
      <!-- Delete button -->
      <button
        v-if="!confirmDelete"
        v-bind="deleteBtn"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z"/></svg>
      </button>
      <button
        v-else
        v-bind="confirmDelBtn"
      >confirm</button>
    </template>
  </div>
</template>

