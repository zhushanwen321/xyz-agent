<template>
  <footer class="statusbar">
    <span class="status-dot" :style="{ background: dotColor }"></span>
    <span>{{ statusText }}</span>
    <span>{{ sessionStore.currentSession?.cwd || '' }}</span>
    <span>{{ sessionStore.currentSession?.modelId || '' }}</span>
    <span class="statusbar-spacer"></span>
    <span class="statusbar-hints">{{ t('status.shortcuts') }}</span>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const sessionStore = useSessionStore()
const connState = getState()

const dotColor = computed(() => {
  switch (connState.value) {
    case 'connected': return 'var(--color-success)'
    case 'reconnecting': return 'var(--color-warning)'
    default: return 'var(--color-border)'
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
  display: flex; align-items: center; height: var(--statusbar-height);
  padding: 0 16px; background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  font-size: 11px; color: var(--color-text-muted); gap: 14px;
}
.status-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
.statusbar-spacer { flex: 1; }
.statusbar-hints { opacity: 0.5; }
</style>
