<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  session: SessionSummary
  isActive: boolean
}>()

const emit = defineEmits<{
  click: []
  rename: [sessionId: string]
  delete: [sessionId: string]
}>()

const { t } = useI18n()

const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })

const statusColor = computed(() =>
  props.session.status === 'active' ? 'var(--color-success)' : 'var(--color-border)'
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

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  contextMenuPos.value = { x: e.clientX, y: e.clientY }
  contextMenuVisible.value = true
}

function closeMenu() {
  contextMenuVisible.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') emit('click')
}

function handleRename() {
  closeMenu()
  emit('rename', props.session.id)
}

function handleDelete() {
  closeMenu()
  emit('delete', props.session.id)
}

function onDocClick() {
  if (contextMenuVisible.value) closeMenu()
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
</script>

<template>
  <div
    :class="['session-item', { active: isActive }]"
    role="button"
    tabindex="0"
    @click="emit('click')"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <span class="status-dot" :style="{ background: statusColor }" />
    <div class="session-info">
      <span class="session-label">{{ session.label }}</span>
      <span class="session-time">{{ relativeTime }}</span>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="contextMenuVisible"
      class="context-menu"
      :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }"
      @click.stop
    >
      <button class="context-menu-item" @click="handleRename">
        {{ t('common.rename') }}
      </button>
      <button class="context-menu-item danger" @click="handleDelete">
        {{ t('common.delete') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.session-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s;
}
.session-item:hover { background: var(--color-accent-light); }
.session-item.active {
  background: var(--color-accent-light);
  border-left-color: var(--color-accent);
}
.session-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.session-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session-label {
  font-size: 13px; color: var(--color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-time { font-size: 11px; color: var(--color-text-muted); }
</style>

<style>
.context-menu {
  position: fixed; z-index: 9999;
  min-width: 140px; padding: 4px 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.context-menu-item {
  display: block; width: 100%; padding: 7px 14px;
  font-size: 13px; text-align: left;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-primary);
}
.context-menu-item:hover { background: var(--color-accent-light); }
.context-menu-item.danger { color: var(--color-danger); }
</style>
