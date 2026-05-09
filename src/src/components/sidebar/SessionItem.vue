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
const confirmDelete = ref(false)

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
    <!-- 删除按钮：默认隐藏，hover 显示；点击进入确认态 -->
    <span
      v-if="!confirmDelete"
      class="s-item__del"
      title="删除"
      @click="startDelete"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z"/></svg>
    </span>
    <span
      v-else
      class="s-item__del s-item__del--confirm"
      @click="confirmDeleteAction"
      @mouseleave="cancelDelete"
    >确认</span>
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

/* 删除按钮 */
.s-item__del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--muted);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s var(--ease), background 0.15s var(--ease), color 0.15s var(--ease);
}
.s-item:hover .s-item__del { opacity: 1; }
.s-item__del:hover { background: var(--danger-light); color: var(--danger); }

/* 确认态 */
.s-item__del--confirm {
  opacity: 1;
  width: auto;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  background: var(--danger);
  color: white;
  border-radius: var(--radius-xs);
}
.s-item__del--confirm:hover {
  opacity: 0.88;
  background: var(--danger);
  color: white;
}
</style>
