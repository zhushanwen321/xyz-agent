<template>
  <footer class="statusbar">
    <div class="statusbar__left">
      <span class="statusbar__conn">
        <span class="statusbar__dot" :style="{ background: dotColor }"></span>
        {{ statusText }}
      </span>
    </div>
    <div class="statusbar__right">
      <span v-if="activeSession?.modelId" class="statusbar__model">{{ activeSession.modelId }}</span>
      <span v-if="tokenDisplay" class="statusbar__tokens">{{ tokenDisplay }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePaneStore } from '../../stores/pane'
import { useChatStore } from '../../stores/chat'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const sessionStore = useSessionStore()
const paneStore = usePaneStore()
const chatStore = useChatStore()
const connState = getState()

const activeSessionId = computed(() => paneStore.focusedPane?.sessionId ?? null)
const activeSession = computed(() => {
  if (!activeSessionId.value) return sessionStore.currentSession
  return sessionStore.sessions.find(s => s.id === activeSessionId.value) ?? sessionStore.currentSession
})

const TOKEN_THRESHOLD = 1000
function formatTokens(n: number) {
  return n >= TOKEN_THRESHOLD
    ? (n / TOKEN_THRESHOLD).toFixed(1) + 'k tokens'
    : n + ' tokens'
}

const tokenDisplay = computed(() => {
  const sid = activeSessionId.value
  if (!sid) return ''
  const state = chatStore.getSessionState(sid)
  return state.contextUsagePercent ? formatTokens(state.contextUsagePercent) : ''
})

const dotColor = computed(() => {
  switch (connState.value) {
    case 'connected': return 'var(--success)'
    case 'reconnecting': return 'var(--warning)'
    default: return 'var(--border)'
  }
})

const statusText = computed(() => {
  switch (connState.value) {
    case 'connected': return t('status.connected')
    case 'reconnecting': return t('status.reconnecting')
    default: return t('status.disconnected')
  }
})
</script>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--statusbar-h);
  padding: 0 16px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}
.statusbar__left,
.statusbar__right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.statusbar__conn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.statusbar__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success);
}
.statusbar__model {
  font-family: var(--font-mono);
  font-size: 10px;
}
.statusbar__tokens {
  font-family: var(--font-mono);
  font-size: 10px;
}
</style>
