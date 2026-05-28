<template>
  <footer class="flex items-center justify-between h-statusbar px-4 bg-surface border-t border-border text-[11px] text-muted shrink-0">
    <div class="inline-flex items-center gap-2 min-w-0">
      <span class="inline-flex items-center gap-1">
        <span class="w-[5px] h-[5px] rounded-full" :style="{ background: dotColor }"></span>
        {{ statusText }}
      </span>
      <template v-for="item in pluginItems" :key="item.id">
        <span class="inline-flex items-center gap-1 border-l border-border pl-2">{{ item.text }}</span>
      </template>
    </div>
    <div class="inline-flex items-center gap-2 min-w-0">
      <span v-if="activeSession?.modelId" class="font-mono text-[10px]">{{ activeSession.modelId }}</span>
      <span v-if="tokenDisplay" class="font-mono text-[10px]">{{ tokenDisplay }}</span>
    </div>
  </footer>
</template>

<script lang="ts">
// Module-level refCount shared across component instances
let _refCount = 0
let _cleanup: (() => void) | null = null
</script>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePanelStore } from '../../stores/panel'
import { useChatStore } from '../../stores/chat'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
import { on } from '../../lib/event-bus'

const { t } = useI18n()
const sessionStore = useSessionStore()
const panelStore = usePanelStore()
const chatStore = useChatStore()
const connState = getState()

const activeSessionId = computed(() => panelStore.focusedPanel?.sessionId ?? null)
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

interface PluginStatusItem {
  id: string
  text: string
  icon?: string
}

const pluginItems = ref<PluginStatusItem[]>([])

onMounted(() => {
  _refCount++
  if (_refCount === 1) {
    _cleanup = on('plugin:status_bar_update', (items: PluginStatusItem[]) => {
      pluginItems.value = items.filter(
        (item, index, arr) => arr.findIndex(i => i.id === item.id) === index,
      )
    })
  }
})

onUnmounted(() => {
  _refCount--
  if (_refCount === 0 && _cleanup) {
    _cleanup()
    _cleanup = null
  }
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

