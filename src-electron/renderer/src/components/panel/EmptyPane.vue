<template>
  <div class="empty-pane">
    <div class="empty-pane__inner">
      <svg class="empty-pane__icon" width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="4" width="48" height="48" rx="12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M20 8v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="16" y1="28" x2="40" y2="28" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="16" y1="34" x2="34" y2="34" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="16" y1="40" x2="30" y2="40" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>

      <h2 class="empty-pane__title">选择一个对话</h2>

      <div v-if="recentSessions.length > 0" class="empty-pane__sessions">
        <div class="empty-pane__sessions-label">最近对话</div>
        <button
          v-for="session in recentSessions"
          :key="session.id"
          class="empty-pane__session-item"
          @click="handleSelectSession(session.id)"
        >
          <svg class="empty-pane__session-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 3.5C2 2.67 2.67 2 3.5 2h7c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-7c-.83 0-1.5-.67-1.5-1.5v-7z" stroke="currentColor" stroke-width="1.2"/>
            <path d="M5 6.5h4M5 9h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          <span class="empty-pane__session-name">{{ session.label || '未命名对话' }}</span>
          <span class="empty-pane__session-cwd">{{ session.cwd }}</span>
        </button>
      </div>

      <button class="empty-pane__create-btn" @click="handleCreateSession">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        新建对话
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePaneStore } from '../../stores/pane'
import { useChatStore } from '../../stores/chat'
import { useSession } from '../../composables/useSession'
import { send } from '../../lib/ws-client'

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
    window.electronAPI.pickDirectory({ title: '选择项目目录' }).then((result) => {
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

<style scoped>
.empty-pane {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  padding: 40px 24px;
}
.empty-pane__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 360px;
  width: 100%;
}
.empty-pane__icon {
  color: var(--muted);
  opacity: 0.5;
  margin-bottom: 20px;
}
.empty-pane__title {
  margin: 0 0 24px;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
  text-align: center;
}
.empty-pane__sessions {
  width: 100%;
  margin-bottom: 20px;
}
.empty-pane__sessions-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 8px;
}
.empty-pane__session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--fg);
  transition: all 0.15s var(--ease, ease);
  margin-bottom: 4px;
  line-height: 1.4;
}
.empty-pane__session-item:last-child {
  margin-bottom: 0;
}
.empty-pane__session-item:hover {
  border-color: var(--accent);
  background: var(--accent-light);
}
.empty-pane__session-icon {
  color: var(--muted);
  flex-shrink: 0;
}
.empty-pane__session-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty-pane__session-cwd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  flex-shrink: 0;
}
.empty-pane__create-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s var(--ease, ease);
}
.empty-pane__create-btn:hover {
  border-color: var(--accent);
  background: var(--accent-light);
  color: var(--accent);
}
.empty-pane__create-btn svg {
  flex-shrink: 0;
}
</style>
