<template>
  <footer class="statusbar">
    <span class="statusbar__dot" :style="{ background: dotColor }"></span>
    <span>{{ statusText }}</span>
    <span>{{ sessionStore.currentSession?.cwd || '' }}</span>
    <span>{{ gitBranch || 'main' }}</span>
    <span>{{ sessionStore.currentSession?.modelId || '' }}</span>
    <span class="statusbar__token-usage">{{ tokenDisplay }}</span>
    <span class="statusbar-spacer"></span>
    <span class="statusbar-hints">
      <kbd>Cmd+J</kbd> 总览 · <kbd>Cmd+1</kbd> 标准 · <kbd>Cmd+2</kbd> 分屏 · <kbd>Cmd+3</kbd> 专注
    </span>
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
function formatTokens(n: number) { return n >= TOKEN_THRESHOLD ? (n / TOKEN_THRESHOLD).toFixed(1) + 'k tok' : n + ' tok' }
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
.statusbar-hints { opacity: 0.5; }
.statusbar-hints kbd {
  display: inline-flex;
  padding: 1px 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
}
</style>
