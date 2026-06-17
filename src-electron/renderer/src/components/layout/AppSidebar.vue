<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePanelStore } from '../../stores/panel'
import { useSession } from '../../composables/useSession'

import { useNavigationStore } from '../../stores/navigation'
import { SessionItem, SidebarCollapseHandle } from '../sidebar'
import { useSidebarStore } from '../../stores/sidebar'
import { useLayoutStore } from '../../stores/layout'
import { Button } from '../../design-system'
import { useI18n } from 'vue-i18n'

// Vite define 在构建时从 package.json 注入
declare const __APP_VERSION__: string
const appVersion = __APP_VERSION__

const { t } = useI18n()
const sessionStore = useSessionStore()
const panelStore = usePanelStore()
const sidebarStore = useSidebarStore()
const layoutStore = useLayoutStore()

const navStore = useNavigationStore()
const { switchSession, deleteSession, renameSession } = useSession()

defineEmits<{
  create: []
  'toggle-panel-grid': []
  'toggle-settings': []
}>()

const renamingSessionId = ref<string | null>(null)

// hiddenInset 模式下 traffic lights 始终存在（非全屏）；全屏时无 traffic lights
// Source of truth: useLayoutStore, kept in sync via api.system.onFullscreenChanged
const isFullscreen = computed(() => layoutStore.isFullscreen)

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
  // 乐观更新 store
  const session = sessionStore.sessions.find(s => s.id === sessionId)
  if (session) {
    session.label = newName
  }
  renamingSessionId.value = null
  renameSession(sessionId, newName)
}

function onCancelRename() {
  renamingSessionId.value = null
}

function handleSessionClick(sessionId: string) {
  switchSession(sessionId)
  panelStore.openSessionSmart(sessionId)
  navStore.push({ view: 'chat', sessionId })
}

const isSettingsActive = computed(() => navStore.currentView === 'settings')
const isCollapsed = computed(() => sidebarStore.collapsed)
</script>

<template>
  <aside v-if="!isCollapsed" class="sidebar">
    <!-- Header: two rows -->
    <div class="sidebar-header" :class="{ 'sidebar-header--fullscreen': isFullscreen }">
      <!-- Row 1: traffic lights space (non-fullscreen) or logo (fullscreen) + nav buttons right -->
      <div class="sidebar-row1">
        <span v-if="isFullscreen" class="sidebar-brand">xyz<span>-agent</span></span>
        <span v-if="isFullscreen" class="text-[10px] text-muted leading-tight" style="margin-left:-2px">v{{ appVersion }}</span>
        <div class="sidebar-nav">
          <!-- eslint-disable-next-line taste/no-native-html-elements -- ctrl-btn has custom gradient+transition styles in <style scoped>, consistent with adjacent native buttons -->
          <button class="ctrl-btn" :title="t('header.overview') + ' (Cmd+J)'" @click="$emit('toggle-panel-grid')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="1" y="1" width="6" height="6" rx="1"/>
              <rect x="9" y="1" width="6" height="6" rx="1"/>
              <rect x="1" y="9" width="6" height="6" rx="1"/>
              <rect x="9" y="9" width="6" height="6" rx="1"/>
            </svg>
          </button>
          <!-- eslint-disable-next-line taste/no-native-html-elements -- ctrl-btn has custom gradient+transition styles in <style scoped>, consistent with adjacent native buttons -->
          <button class="ctrl-btn" :class="{ active: isSettingsActive }" :title="t('header.settings') + ' (Cmd+,)'" @click="$emit('toggle-settings')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008.58 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 8.58a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
          <Button variant="ghost" size="icon" class="ctrl-btn" title="Back" @click="navStore.back()" :disabled="!navStore.canGoBack">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3L5 8l5 5"/></svg>
          </Button>
          <Button variant="ghost" size="icon" class="ctrl-btn" title="Forward" @click="navStore.forward()" :disabled="!navStore.canGoForward">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3l5 5-5 5"/></svg>
          </Button>

          <!-- Collapse sidebar button: last item in nav row, panel-left icon -->
          <!-- eslint-disable-next-line taste/no-native-html-elements -->
          <button class="ctrl-btn" title="Collapse sidebar" @click="sidebarStore.toggle()">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2"/>
              <line x1="11" y1="1.5" x2="11" y2="14.5"/>
            </svg>
          </button>
        </div>
      </div>
      <!-- Row 2: logo + new session (non-fullscreen) or full-width new session (fullscreen) -->
      <div class="sidebar-row2">
        <span v-if="!isFullscreen" class="sidebar-brand">xyz<span>-agent</span></span>
        <span v-if="!isFullscreen" class="text-[10px] text-muted leading-tight">v{{ appVersion }}</span>
        <!-- eslint-disable-next-line taste/no-native-html-elements -->
        <button class="sidebar__new" :class="{ 'sidebar__new--wide': isFullscreen }" @click="$emit('create')">+ New Session</button>
      </div>
    </div>

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
  </aside>

  <!-- Standalone expand button when sidebar is collapsed -->
  <SidebarCollapseHandle v-if="isCollapsed" />
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
}

/* ---- Header: two rows ---- */
.sidebar-header {
  flex-shrink: 0;
}

.sidebar-row1 {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Non-fullscreen: left padding for traffic lights */
  padding: 8px 14px 4px 78px;
  position: relative;
  -webkit-app-region: drag;
}
/* Interactive elements inside row1 must not trigger window drag */
.sidebar-row1 button,
.sidebar-row1 .ctrl-btn,
.sidebar-row1 .sidebar-nav {
  -webkit-app-region: no-drag;
}

.sidebar-row2 {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 14px 8px 14px;
}

.sidebar-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* Fullscreen: no traffic lights, logo in row1, padding-left normal */
.sidebar-header--fullscreen .sidebar-row1 {
  padding-left: 14px;
}

/* ---- Controls ---- */
.ctrl-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 1px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.ctrl-btn:hover { background: var(--hover-bg); color: var(--fg); }
.ctrl-btn.active { background: var(--hover-bg); color: var(--accent); }
.ctrl-btn svg { width: 13px; height: 13px; }

.sidebar-brand {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.sidebar-brand span { color: var(--accent); }

.sidebar__new {
  margin-left: auto;
  padding: 3px 12px;
  border-radius: 1px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.15s;
  line-height: 1;
  white-space: nowrap;
}
.sidebar__new:hover { border-color: var(--muted); color: var(--fg); }
.sidebar__new--wide {
  width: 100%;
  text-align: center;
  padding: 6px 12px;
  margin-left: 0;
}

/* ---- Session list ---- */
.sidebar__body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
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

/* ---- End ---- */
</style>
