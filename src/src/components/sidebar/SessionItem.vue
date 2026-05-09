<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import { useI18n } from 'vue-i18n'
import { Dropdown } from '../../design-system'

const props = defineProps<{
  session: SessionSummary & { doneCount?: number; alertCount?: number }
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

// 映射到 HTML 原型的 dot--run / dot--idle / dot--pause 三种状态
const dotClass = computed(() => {
  switch (props.session.status) {
    case 'active': return 'dot dot--run'
    default: return 'dot dot--idle'
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
    :class="['s-item', { active: isActive, 'has-notif': hasNotif }]"
    role="button"
    tabindex="0"
    @click="emit('click')"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <span :class="dotClass" />
    <span class="s-item__title">{{ session.label }}</span>
    <span v-if="(session.doneCount ?? 0) > 0" class="s-item__notif s-item__notif--done">{{ session.doneCount }}</span>
    <span v-if="(session.alertCount ?? 0) > 0" class="s-item__notif s-item__notif--alert">{{ session.alertCount }}</span>
    <span class="s-item__meta">{{ relativeTime }}</span>
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
/* 与 css_design-system.css 中的 .s-item 样式对齐，但 scoped 需要重新声明关键规则 */
.s-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px 7px 24px; cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s var(--ease), border-color 0.15s var(--ease);
  user-select: none;
}
.s-item:hover { background: var(--accent-light); }
.s-item.active {
  background: var(--accent-light);
  border-left-color: var(--accent);
}
.s-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.s-item__title {
  flex: 1; font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.s-item__meta {
  font-size: 11px; color: var(--muted); white-space: nowrap;
  display: flex; align-items: center; gap: 4px;
}
.s-item__notif {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 14px; height: 14px; border-radius: 7px;
  font-size: 9px; font-weight: 700; color: white;
  margin-left: 4px; flex-shrink: 0;
}
.s-item__notif--done { background: var(--success); }
.s-item__notif--alert { background: var(--danger); }
.s-item.has-notif .s-item__title { font-weight: 600; }
</style>
