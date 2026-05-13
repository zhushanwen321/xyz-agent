<template>
  <div class="flex-1 flex items-center justify-center min-w-0 min-h-0 p-10 px-6">
    <div class="flex flex-col items-center max-w-[360px] w-full">
      <svg class="text-muted opacity-50 mb-5" width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="4" width="48" height="48" rx="12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M20 8v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="16" y1="28" x2="40" y2="28" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="16" y1="34" x2="34" y2="34" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="16" y1="40" x2="30" y2="40" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>

      <h2 class="m-0 mb-6 text-base font-semibold text-fg text-center">{{ t('panel.selectConversation') }}</h2>

      <div v-if="recentSessions.length > 0" class="w-full mb-5">
        <div class="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted mb-2">{{ t('panel.recentConversations') }}</div>
        <button
          v-for="session in recentSessions"
          :key="session.id"
          class="flex items-center gap-2 w-full px-3 py-2 border border-border rounded-sm bg-surface cursor-pointer font-body text-[13px] text-fg transition-all duration-150 ease-ease mb-1 leading-snug hover:border-accent hover:bg-accent-light"
          @click="handleSelectSession(session.id)"
        >
          <svg class="text-muted shrink-0" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 3.5C2 2.67 2.67 2 3.5 2h7c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-7c-.83 0-1.5-.67-1.5-1.5v-7z" stroke="currentColor" stroke-width="1.2"/>
            <path d="M5 6.5h4M5 9h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span class="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{{ session.label || t('panel.unnamedConversation') }}</span>
          <span class="font-mono text-[11px] text-muted whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px] shrink-0">{{ session.cwd }}</span>
        </button>
      </div>

      <button class="inline-flex items-center gap-1.5 px-5 py-2 border border-border rounded-sm bg-surface text-fg font-body text-[13px] font-medium cursor-pointer transition-all duration-150 ease-ease hover:border-accent hover:bg-accent-light hover:text-accent" @click="handleCreateSession">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        {{ t('panel.newConversation') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../../stores/session'
import { usePaneStore } from '../../stores/pane'
import { useChatStore } from '../../stores/chat'
import { useSession } from '../../composables/useSession'
import { send } from '../../lib/ws-client'

const { t } = useI18n()

const props = defineProps<{
  paneId: string
}>()

const sessionStore = useSessionStore()
const paneStore = usePaneStore()
const chatStore = useChatStore()
const { createSession: doCreateSession } = useSession()

// Track session creation to bind new session to this pane
const isCreating = ref(false)
const prevSessionCount = ref(0)

const recentSessions = computed(() => {
  return sessionStore.sessions.slice(0, 5)
})

function handleSelectSession(sessionId: string) {
  paneStore.bindSession(props.paneId, sessionId)
  // Load history for the selected session
  chatStore.ensureSession(sessionId)
  send({ type: 'session.history', payload: { sessionId } })
}

function handleCreateSession() {
  isCreating.value = true
  prevSessionCount.value = sessionStore.sessions.length
  // Use Electron directory picker
  if (window.electronAPI?.pickDirectory) {
    window.electronAPI.pickDirectory({ title: t('panel.selectProjectDir') }).then((result) => {
      if (result.canceled || !result.path) {
        isCreating.value = false
        return
      }
      const label = sessionStore.generateSessionLabel(result.path)
      doCreateSession(result.path, label)
    })
  } else {
    // Fallback for non-Electron environments
    const cwd = sessionStore.currentSession?.cwd || '/Users/zhushanwen/Code/xyz-agent'
    const label = sessionStore.generateSessionLabel(cwd)
    doCreateSession(cwd, label)
  }
}

// When a new session appears after creation, bind it to this pane
watch(() => sessionStore.sessions.length, (newLen) => {
  if (isCreating.value && newLen > prevSessionCount.value && sessionStore.sessions.length > 0) {
    const newest = sessionStore.sessions[0]
    if (newest) {
      paneStore.bindSession(props.paneId, newest.id)
    }
    isCreating.value = false
  }
})
</script>

