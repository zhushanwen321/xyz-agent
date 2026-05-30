<script setup lang="ts">
import { computed } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import { useSessionStore } from '../../stores/session'
import { usePanelStore } from '../../stores/panel'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
import type { PluginStatusItem } from '../../types/plugin'

const PI_VERSION = '0.75.5-xyz-0.1'

const { t } = useI18n()
const pluginStore = usePluginStore()
const sessionStore = useSessionStore()
const panelStore = usePanelStore()
const connState = getState()

// ── Branch name from focused session ───────────────────────────

const activeSessionId = computed(() => panelStore.focusedPanel?.sessionId ?? null)

const branchName = computed(() => {
  const sid = activeSessionId.value
  if (!sid) return ''
  const session = sessionStore.sessions.find(s => s.id === sid)
  if (!session?.cwd) return ''
  const parts = session.cwd.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || ''
})

// ── Plugin status bar items (global scope only) ────────────────

const globalStatusBarItems = computed(() => pluginStore.globalStatusBarItems)

function handleStatusItemClick(item: PluginStatusItem) {
  if (item.commandId) {
    pluginStore.executeCommand(item.pluginId, item.commandId)
  }
}

// ── Connection status ──────────────────────────────────────────

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

<template>
  <footer class="flex items-center justify-between h-statusbar px-3.5 bg-surface border-t border-border text-[11px] text-muted shrink-0">
    <!-- Left: connection + branch -->
    <div class="inline-flex items-center gap-3 min-w-0">
      <span class="inline-flex items-center gap-1">
        <span class="w-[5px] h-[5px] rounded-full" :style="{ background: dotColor }"></span>
        {{ statusText }}
      </span>
      <span v-if="branchName" class="text-[10px] text-accent truncate max-w-[160px]">{{ branchName }}</span>
      <span class="text-[10px] text-muted">pi {{ PI_VERSION }}</span>
    </div>

    <!-- Right: global extension chips -->
    <div class="inline-flex items-center gap-2 min-w-0">
      <template v-for="(item, idx) in globalStatusBarItems" :key="item.id">
        <span v-if="idx > 0" class="w-px h-3 bg-border shrink-0"></span>
        <span
          role="button"
          tabindex="0"
          :class="[
            'inline-flex items-center gap-1 text-[10px] transition-colors',
            item.commandId ? 'cursor-pointer hover:text-fg' : 'cursor-default',
          ]"
          :title="item.tooltip ?? ''"
          @click="handleStatusItemClick(item)"
        >{{ item.text }}</span>
      </template>
    </div>
  </footer>
</template>
