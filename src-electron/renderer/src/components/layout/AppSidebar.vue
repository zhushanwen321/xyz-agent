<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePaneStore } from '../../stores/pane'
import { useSession } from '../../composables/useSession'
import { send } from '../../lib/ws-client'
import { SessionItem } from '../sidebar'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const sessionStore = useSessionStore()
const paneStore = usePaneStore()
const { switchSession, deleteSession } = useSession()

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  create: []
  close: []
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
  paneStore.openSessionSmart(sessionId)
  emit('close')
}
</script>

<template>
  <aside :class="['sidebar-drawer', { visible: props.visible }]">
    <div class="sidebar__hd">
      <span class="sidebar__hd-title">{{ t('sidebar.sessions') }}</span>
      <div class="sidebar__hd-actions">
        <button class="sidebar__hd-btn" @click="$emit('create')" :title="t('sidebar.newSession')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="sidebar__hd-btn" @click="$emit('close')" title="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
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
              @click="handleSessionClick(session.id)"
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
.sidebar-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 280px;
  z-index: 60;
  background: var(--surface);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.2s ease-out;
  display: flex;
  flex-direction: column;
}
.sidebar-drawer.visible {
  transform: translateX(0);
}
.sidebar__hd { @apply flex items-center justify-between px-[14px] py-[10px] border-b border-solid border-[var(--border)]; }
.sidebar__hd-title { @apply text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]; }
.sidebar__hd-actions { @apply flex items-center gap-[4px]; }
.sidebar__hd-btn { @apply w-[22px] h-[22px] rounded-[var(--radius-xs)] border border-solid border-[var(--border)] bg-transparent text-[var(--muted)] text-[13px] cursor-pointer flex items-center justify-center; transition: all 0.2s var(--ease); }
.sidebar__hd-btn:hover { @apply bg-[var(--accent-light)] text-[var(--accent)]; border-color: var(--accent); }
.sidebar__hd-btn:focus-visible { @apply outline-2 outline-[var(--accent)]; outline-offset: -2px; }
.sidebar__hd-btn svg { @apply w-[14px] h-[14px]; }
.sidebar__body { @apply flex-1 overflow-y-auto py-[6px] px-0; }
.s-group__hd {
  @apply flex items-center gap-[5px] px-[14px] py-[6px] text-xs font-medium normal-case tracking-normal text-[var(--muted)] cursor-pointer select-none;
}
.s-group__hd:hover { color: var(--fg); }
.s-group__hd:focus-visible { @apply outline-2 outline-[var(--accent)]; outline-offset: -2px; }
.s-group__toggle {
  @apply text-[8px] inline-block w-[10px] text-center;
  transition: transform 0.2s var(--ease);
}
.s-group.collapsed .s-group__toggle { transform: rotate(-90deg); }
.no-sessions {
  @apply px-[14px] py-[20px] text-center text-[var(--muted)] text-xs;
}
</style>
