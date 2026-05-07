<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import { useI18n } from 'vue-i18n'
import { Dropdown } from '../../design-system'

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

const dropdownOpen = ref(false)
const dropdownPos = ref({ x: 0, y: 0 })

const statusColor = computed(() =>
  props.session.status === 'active' ? 'var(--accent)' : 'var(--border)'
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

const menuItems = computed(() => [
  { label: t('common.rename'), value: 'rename' },
  { label: t('common.delete'), value: 'delete' },
])

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  dropdownPos.value = { x: e.clientX, y: e.clientY }
  dropdownOpen.value = true
}

function handleMenuSelect(action: string) {
  dropdownOpen.value = false
  if (action === 'rename') emit('rename', props.session.id)
  if (action === 'delete') emit('delete', props.session.id)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') emit('click')
}

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
    <span :class="['status-dot', { 'status-dot--running': session.status === 'active' }]" :style="{ background: statusColor }" />
    <div class="session-info">
      <span class="session-label">{{ session.label }}</span>
      <span class="session-time">{{ relativeTime }}</span>
    </div>
  </div>

  <Dropdown
    :open="dropdownOpen"
    :position="dropdownPos"
    :items="menuItems"
    @update:open="dropdownOpen = $event"
    @select="handleMenuSelect"
  />
</template>

<style scoped>
.session-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px 7px 24px; cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s;
}
.session-item:hover { background: var(--accent-light); }
.session-item.active {
  background: var(--accent-light);
  border-left-color: var(--accent);
}
.session-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.status-dot--running { animation: dot-pulse 2s infinite; }
.session-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session-label {
  font-size: 13px; color: var(--fg);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-time { font-size: 11px; color: var(--muted); }
@keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
