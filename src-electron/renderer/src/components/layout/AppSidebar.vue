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
  <aside :class="['fixed top-0 left-0 bottom-0 w-[280px] z-[60] bg-surface border-r border-border -translate-x-full transition-transform duration-200 ease-out flex flex-col', { 'translate-x-0': props.visible }]">
    <div class="flex items-center justify-between px-[14px] py-[10px] border-b border-solid border-border">
      <span class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{{ t('sidebar.sessions') }}</span>
      <div class="flex items-center gap-1">
        <button class="w-[22px] h-[22px] rounded-xs border border-solid border-border bg-transparent text-muted text-[13px] cursor-pointer flex items-center justify-center transition-all duration-200 ease-ease hover:bg-accent-light hover:text-accent hover:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" @click="$emit('create')" :title="t('sidebar.newSession')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="w-[22px] h-[22px] rounded-xs border border-solid border-border bg-transparent text-muted text-[13px] cursor-pointer flex items-center justify-center transition-all duration-200 ease-ease hover:bg-accent-light hover:text-accent hover:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" @click="$emit('close')" title="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto py-[6px]">
      <template v-if="sessionStore.groupedSessions.length > 0">
        <div v-for="group in sessionStore.groupedSessions" :key="group.cwd" class="s-group">
          <div class="flex items-center gap-[5px] px-[14px] py-[6px] text-xs font-medium normal-case tracking-normal text-muted cursor-pointer select-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" tabindex="0" @click="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')" @keydown.enter="($event.currentTarget as HTMLElement).parentElement?.classList.toggle('collapsed')">
            <span class="s-group__toggle text-[8px] inline-block w-[10px] text-center transition-transform duration-200 ease-ease">&#9662;</span>
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
      <div v-else class="px-[14px] py-[20px] text-center text-muted text-xs">
        {{ t('sidebar.noSessions') }}
      </div>
    </div>
  </aside>
</template>


<style scoped>
/* Parent-child selector required: collapsed toggle rotation via DOM class toggle */
.s-group.collapsed .s-group__toggle { transform: rotate(-90deg); }
.s-group.collapsed .s-group__items { display: none; }
</style>
