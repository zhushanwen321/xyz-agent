<template>
  <footer class="flex items-center justify-between h-statusbar px-4 bg-surface border-t border-border text-[11px] text-muted shrink-0">
    <div class="inline-flex items-center gap-2 min-w-0">
      <span class="inline-flex items-center gap-1">
        <span class="w-[5px] h-[5px] rounded-full" :style="{ background: dotColor }"></span>
        {{ statusText }}
      </span>
      <template v-for="item in pluginStatusBarItems" :key="item.id">
        <span
          role="button"
          tabindex="0"
          class="inline-flex items-center gap-1 border-l border-border pl-2 hover:text-fg transition-colors cursor-pointer disabled:cursor-default disabled:hover:text-muted"
          :class="{ 'cursor-default hover:text-muted': !item.commandId }"
          :title="item.tooltip ?? ''"
          @click="handleStatusItemClick(item)"
        >{{ item.text }}</span>
      </template>
    </div>
    <div class="inline-flex items-center gap-2 min-w-0">
      <span v-if="activeSession?.modelId" class="font-mono text-[10px]">{{ activeSession.modelId }}</span>
      <span v-if="tokenDisplay" class="font-mono text-[10px]">{{ tokenDisplay }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { usePanelStore } from '../../stores/panel'
import { useChatStore } from '../../stores/chat'
import { usePluginStore } from '../../stores/plugin'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
import type { PluginStatusItem } from '../../types/plugin'

const { t } = useI18n()
const sessionStore = useSessionStore()
const panelStore = usePanelStore()
const chatStore = useChatStore()
const pluginStore = usePluginStore()
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

/** Plugin status bar items from store, sorted by priority */
const pluginStatusBarItems = computed(() => pluginStore.allStatusBarItems)

/** Handle click on a plugin status bar item */
function handleStatusItemClick(item: PluginStatusItem) {
  if (item.commandId) {
    pluginStore.executeCommand(item.pluginId, item.commandId)
  }
}

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

