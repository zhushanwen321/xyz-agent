<script setup lang="ts">
import { computed } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import { useExtensionWidget } from '../../composables/useExtensionWidget'
import { getState } from '../../lib/ws-client'
import { useI18n } from 'vue-i18n'
import type { PluginStatusItem } from '../../types/plugin'

const PI_VERSION = '0.75.5-xyz-0.1'

const { t } = useI18n()
const pluginStore = usePluginStore()
const { statuses: extStatuses } = useExtensionWidget()
const connState = getState()

// ── Branch name is displayed in SessionStrip (per-session) ─────
// AppStatusbar only shows global info (connection, version, global chips)

// ── Plugin status bar items (global scope only) ────────────────

const globalStatusBarItems = computed(() => pluginStore.globalStatusBarItems)

const extStatusItems = computed(() => {
  return Array.from(extStatuses.value.values())
})

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
  <footer class="flex items-center justify-between h-statusbar px-3.5 bg-surface border-t border-border text-[11px] text-muted shrink-0 col-span-2">
    <!-- Left: connection + version -->
    <div class="inline-flex items-center gap-3 min-w-0">
      <span class="inline-flex items-center gap-1">
        <span class="w-[5px] h-[5px] rounded-full" :style="{ background: dotColor }"></span>
        {{ statusText }}
      </span>
      <span class="text-[10px] text-muted">pi {{ PI_VERSION }}</span>
    </div>

    <!-- Right: global extension + plugin chips -->
    <div class="inline-flex items-center gap-2 min-w-0">
      <template v-for="s in extStatusItems" :key="s.statusKey">
        <span class="w-px h-3 bg-border shrink-0"></span>
        <span class="inline-flex items-center gap-1 text-[10px] text-muted" :title="s.statusKey">{{ s.text }}</span>
      </template>
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
