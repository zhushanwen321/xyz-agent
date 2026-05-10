<template>
  <footer class="statusbar">
    <span style="display:inline-flex;align-items:center;gap:4px;"><span class="statusbar__dot" :style="{ background: dotColor }"></span> {{ statusText }}</span>
    <span>{{ sessionStore.currentSession?.modelId || '' }}</span>
    <span class="statusbar-spacer"></span>
  </footer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const connState = getState()
const gitBranch = ref('')

const TOKEN_THRESHOLD = 1000
function formatTokens(n: number) { return n >= TOKEN_THRESHOLD ? (n / TOKEN_THRESHOLD).toFixed(1) + 'k tokens' : n + ' tokens' }
const tokenDisplay = computed(() => chatStore.contextUsagePercent ? formatTokens(chatStore.contextUsagePercent) : '')

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
.statusbar { flex-shrink: 0; }
.statusbar-spacer { flex: 1; }
</style>
