import { onMounted, onUnmounted } from 'vue'
import { getActivePinia } from 'pinia'
import { api } from '../api'
import { usePluginStore } from '../stores/plugin'
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import type {
  PluginViewModel,
  PluginStatusItem,
  PluginMessageDecoration,
} from '../types/plugin'

// ── Global event handler creation ──────────────────────────────

function createPluginHandlers(): Map<ServerMessageType, (msg: ServerMessage) => void> {
  const store = usePluginStore()

  return new Map<ServerMessageType, (msg: ServerMessage) => void>([
    /** Full plugin list refresh (response to plugin.list / plugin.toggle / plugin.uninstall) */
    ['config.plugins', (msg: ServerMessage) => {
      const payload = msg.payload as { plugins?: PluginViewModel[] }
      if (payload.plugins) {
        store.setPlugins(payload.plugins)
      }
    }],

    /** Single plugin status change push */
    ['plugin:statusChange', (msg: ServerMessage) => {
      const { pluginId, newStatus } = msg.payload as { pluginId: string; newStatus: string }
      store.setStatusChange(pluginId, newStatus)
    }],

    /** Plugin crashed */
    ['plugin:crashed', (msg: ServerMessage) => {
      const { pluginId, error } = msg.payload as { pluginId: string; error: string }
      store.setCrashed(pluginId, error)
    }],

    /** Plugin notification */
    ['plugin:notification', (msg: ServerMessage) => {
      const n = msg.payload as { pluginId: string; level: 'info' | 'warning' | 'error'; message: string }
      store.addNotification(n)
    }],

    /** Permission request */
    ['plugin:permissionRequest', (msg: ServerMessage) => {
      const { pluginId, permissions } = msg.payload as { pluginId: string; permissions: string[] }
      store.setPermissionRequest(pluginId, permissions)
    }],

    /** Status bar items update */
    ['plugin:statusBarUpdate', (msg: ServerMessage) => {
      const { items } = msg.payload as { items: PluginStatusItem[] }
      store.setStatusBarItems(items)
    }],

    /** Message decorations */
    ['plugin:messageDecoration', (msg: ServerMessage) => {
      const { messageId, decorations } = msg.payload as {
        messageId: string
        decorations: PluginMessageDecoration[]
      }
      store.setMessageDecorations(messageId, decorations)
    }],

    /** Plugin config response */
    ['plugin:config', (msg: ServerMessage) => {
      const { pluginId, config } = msg.payload as {
        pluginId: string
        config: Record<string, unknown>
      }
      store.setPluginConfig(pluginId, config)
    }],
  ])
}

// ── Global listener lifecycle (refCount pattern) ───────────────

let globalPluginHandlers: Map<ServerMessageType, (msg: ServerMessage) => void> | null = null
let globalOffs: Array<() => void> = []
let _refCount = 0

function registerGlobalListeners() {
  if (globalPluginHandlers) return
  globalPluginHandlers = createPluginHandlers()
  globalOffs = []
  for (const [evt, handler] of globalPluginHandlers) {
    globalOffs.push(api.events.on(evt, handler))
  }
}

function unregisterGlobalListeners() {
  if (!globalPluginHandlers) return
  for (const off of globalOffs) off()
  globalOffs = []
  globalPluginHandlers = null
}

// ── usePlugin composable ───────────────────────────────────────

/**
 * Plugin WS event composable.
 *
 * Registers global event listeners on first mount, unregisters on last unmount.
 * Automatically fetches plugin list on first mount if store is empty.
 *
 * Follows useChat.ts pattern for global event handler registration.
 * Uses refCount to avoid empty-spinning when no plugin components are mounted.
 */
export function usePlugin() {
  const store = usePluginStore()

  onMounted(() => {
    _refCount++
    if (_refCount === 1) {
      registerGlobalListeners()
    }
    // Auto-fetch plugin list on first mount if empty
    if (store.installedPlugins.length === 0 && !store.loading) {
      store.fetchPlugins()
    }
  })

  onUnmounted(() => {
    _refCount--
    if (_refCount === 0) {
      unregisterGlobalListeners()
    }
  })

  return { store }
}

// ── Module-level safe registration (fallback for non-component usage) ──

let registerAttempted = false

/**
 * Register global plugin listeners at module level (similar to useChat.ts).
 * Safe to call multiple times; only registers once after Pinia is active.
 */
export function ensurePluginListeners() {
  if (globalPluginHandlers || registerAttempted) return
  registerAttempted = true
  if (!getActivePinia()) {
    console.warn('[usePlugin] Pinia not active, global listeners deferred')
    return
  }
  registerGlobalListeners()
}
