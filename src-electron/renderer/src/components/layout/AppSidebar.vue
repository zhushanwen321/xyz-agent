<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../../stores/session'
import { useSession } from '../../composables/useSession'
import { send } from '../../lib/ws-client'
import { SessionItem } from '../sidebar'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const sessionStore = useSessionStore()
const { switchSession, deleteSession } = useSession()

const renamingSessionId = ref<string | null>(null)

defineEmits<{ create: [] }>()

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
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__hd">
      <span class="sidebar__hd-title">{{ t('sidebar.sessions') }}</span>
      <button class="sidebar__hd-btn" @click="$emit('create')" :title="t('sidebar.newSession')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><path d="M8 3v10M3 8h10"/></svg>
      </button>
    </div>

    <div class="sidebar__body">
      <template v-if="sessionStore.groupedSessions.length > 0">
        <div v-for="group in sessionStore.groupedSessions" :key="group.cwd" class="s-group">
          <div class="s-group__hd" tabindex="0" @click="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')" @keydown.enter="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')">
            <span class="s-group__toggle">&#9662;</span>
            {{ dirname(group.cwd) }}
          </div>
          <div class="s-group__items">
            <SessionItem
              v-for="session in group.sessions"
              :key="session.id"
              :session="session"
              :is-active="session.id === sessionStore.currentSessionId"
              :renaming="renamingSessionId === session.id"
              @click="switchSession(session.id)"
              @rename="onStartRename($event)"
              @confirm-rename="(_id: string, newName: string) => onConfirmRename(session.id, newName)"
              @cancel-rename="onCancelRename"
              @delete="onDelete($event)"
            />
          </div>
        </div>
      </template>
      <div v-else class="no-sessions">
        {{ t('sidebar.noSessions') }}
      </div>
    </div>
  </aside>
</template>


<style scoped>
.sidebar {
  width: var(--sidebar-w);
  z-index: 55;
  display: flex; flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar__hd-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sidebar__hd-btn svg { width: 14px; height: 14px; }
.s-group__hd {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 14px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--muted); cursor: pointer; user-select: none;
}
.s-group__hd:hover { color: var(--fg); }
.s-group__hd:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.s-group__toggle {
  font-size: 8px; transition: transform 0.2s var(--ease);
  display: inline-block; width: 10px; text-align: center;
}
.s-group.collapsed .s-group__toggle { transform: rotate(-90deg); }
.no-sessions {
  padding: 20px 14px; text-align: center;
  color: var(--muted); font-size: 12px;
}
</style>
