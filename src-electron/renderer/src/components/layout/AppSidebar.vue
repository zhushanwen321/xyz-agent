<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePanelStore } from '../../stores/panel'
import { useSession } from '../../composables/useSession'
import { useSettingsStore } from '../../stores/settings'
import { send } from '../../lib/ws-client'
import { SessionItem } from '../sidebar'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const sessionStore = useSessionStore()
const panelStore = usePanelStore()
const settingsStore = useSettingsStore()
const { switchSession, deleteSession } = useSession()

defineEmits<{
  create: []
  'toggle-panel-grid': []
  'toggle-settings': []
}>()

const renamingSessionId = ref<string | null>(null)

function dirname(cwd: string): string {
  const parts = cwd.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

function onDelete(sessionId: string) {
  deleteSession(sessionId)
}

function onStartRename(sessionId: string) {
  renamingSessionId.value = sessionId
}

function onConfirmRename(sessionId: string, newName: string) {
  const session = sessionStore.sessions.find(s => s.id === sessionId)
  if (session) {
    session.label = newName
  }
  renamingSessionId.value = null
  send({ type: 'session.rename', payload: { sessionId, name: newName } })
}

function onCancelRename() {
  renamingSessionId.value = null
}

function handleSessionClick(sessionId: string) {
  switchSession(sessionId)
  panelStore.openSessionSmart(sessionId)
}

const isSettingsActive = computed(() => settingsStore.currentView === 'settings')
</script>

<template>
  <aside class="sidebar">
    <!-- Top: Controls -->
    <div class="sidebar__top">
      <button class="ctrl-btn" :title="t('header.overview') + ' (Cmd+J)'" @click="$emit('toggle-panel-grid')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="1" y="1" width="6" height="6" rx="1"/>
          <rect x="9" y="1" width="6" height="6" rx="1"/>
          <rect x="1" y="9" width="6" height="6" rx="1"/>
          <rect x="9" y="9" width="6" height="6" rx="1"/>
        </svg>
      </button>
      <button class="ctrl-btn" :class="{ active: isSettingsActive }" :title="t('header.settings') + ' (Cmd+,)'" @click="$emit('toggle-settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008.58 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 8.58a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
      <!-- eslint-disable-next-line taste/no-native-html-elements -->
      <button class="sidebar__new" @click="$emit('create')">+ New</button>
    </div>

    <!-- Brand -->
    <div class="sidebar__brand">xyz<span>-agent</span></div>

    <!-- Session list -->
    <div class="sidebar__body">
      <template v-if="sessionStore.groupedSessions.length > 0">
        <div v-for="group in sessionStore.groupedSessions" :key="group.cwd" class="s-group">
          <div class="sg-hd" tabindex="0" @click="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')" @keydown.enter="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')">
            <svg class="sg-hd__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></svg>
            {{ dirname(group.cwd) }}
          </div>
          <div class="s-group__items">
            <SessionItem
              v-for="session in group.sessions"
              :key="session.id"
              :session="session"
              :is-active="session.id === sessionStore.currentSessionId"
              :renaming="renamingSessionId === session.id"
              @click="handleSessionClick(session.id)"
              @rename="onStartRename($event)"
              @confirm-rename="(_id: string, newName: string) => onConfirmRename(session.id, newName)"
              @cancel-rename="onCancelRename"
              @delete="onDelete($event)"
            />
          </div>
        </div>
      </template>
      <div v-else class="empty">
        {{ t('sidebar.noSessions') }}
      </div>
    </div>

    <!-- Bottom: User + Status -->
    <div class="sidebar__btm">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M8 11a3 3 0 100-6 3 3 0 000 6z"/><path d="M1.6 13a7 7 0 0112.8 0"/>
      </svg>
      <span class="sidebar__btm-user">{{ t('sidebar.user') ?? 'User' }}</span>
      <span class="sidebar__btm-status">● ws</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
  /* No border-right — color difference separates from content */
}

.sidebar__top {
  display: flex;
  align-items: center;
  gap: 6px;
  /* macOS traffic lights 浮在左上角，padding 使 ctrl-btn 与红绿灯垂直居中对齐 */
  padding: 7px 14px 8px 78px;
  flex-shrink: 0;
}

.ctrl-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.ctrl-btn:hover { background: oklch(22% 0 0); color: var(--fg); }
.ctrl-btn.active { background: oklch(22% 0 0); color: var(--accent); }
.ctrl-btn svg { width: 13px; height: 13px; }

.sidebar__new {
  margin-left: auto;
  padding: 3px 9px;
  border-radius: 2px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.15s;
  line-height: 1;
}
.sidebar__new:hover { border-color: var(--muted); color: var(--fg); }

.sidebar__brand {
  padding: 0 14px 10px;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: -0.01em;
  flex-shrink: 0;
}
.sidebar__brand span { color: var(--accent); }

.sidebar__body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}

.sg-hd {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.sg-hd:hover { color: var(--fg); }
.sg-hd__chevron {
  width: 10px;
  height: 10px;
  transition: transform 0.2s ease;
}
.s-group.collapsed .sg-hd__chevron { transform: rotate(-90deg); }
.s-group.collapsed .s-group__items { display: none; }

.empty {
  padding: 20px 14px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.sidebar__btm {
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar__btm svg { width: 14px; height: 14px; }
.sidebar__btm-user { flex: 1; }
.sidebar__btm-status { color: var(--success); font-size: 10px; }
</style>
