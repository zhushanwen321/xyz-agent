import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import { send } from '../lib/ws-client'
import type {
  PluginViewModel,
  PluginStatusItem,
  PluginMessageDecoration,
  PluginNotification,
} from '../types/plugin'

const MAX_NOTIFICATIONS = 50

export const usePluginStore = defineStore('plugin', () => {
  // ── State ────────────────────────────────────────────────────

  /** Full plugin list received from sidecar (config.plugins response) */
  const installedPlugins = ref<PluginViewModel[]>([])

  /** Fast status lookup: pluginId → status string */
  const pluginStatuses = reactive(new Map<string, string>())

  /** Recent plugin notifications (capped at MAX_NOTIFICATIONS) */
  const pluginNotifications = ref<PluginNotification[]>([])

  /** Pending permission requests: pluginId → requested permissions */
  const permissionRequests = reactive(new Map<string, string[]>())

  /** Active status bar items from all plugins */
  const statusBarItems = ref<PluginStatusItem[]>([])

  /** Message decorations: messageId → decorations */
  const messageDecorations = reactive(new Map<string, PluginMessageDecoration[]>())

  /** Plugin configs: pluginId → key-value map */
  const pluginConfigs = reactive(new Map<string, Record<string, unknown>>())

  const loading = ref(false)
  const error = ref<string | null>(null)

  // ── Getters ──────────────────────────────────────────────────

  const activePlugins = computed(() =>
    installedPlugins.value.filter(p => p.status === 'active'),
  )

  const pluginList = computed(() => installedPlugins.value)

  const builtInPlugins = computed(() =>
    installedPlugins.value.filter(p => p.source === 'built-in'),
  )

  const externalPlugins = computed(() =>
    installedPlugins.value.filter(p => p.source === 'external'),
  )

  /** All slash commands from active plugins */
  const allSlashCommands = computed(() => {
    const cmds: Array<{ name: string; description: string; pluginId: string }> = []
    for (const p of activePlugins.value) {
      for (const cmd of p.contributes?.slashCommands ?? []) {
        cmds.push({ ...cmd, pluginId: p.pluginId })
      }
    }
    return cmds
  })

  /** All status bar items from active plugins, sorted by priority */
  const allStatusBarItems = computed(() =>
    [...statusBarItems.value].sort((a, b) => a.priority - b.priority),
  )

  /** Global-scope status bar items, sorted by priority */
  const globalStatusBarItems = computed(() =>
    statusBarItems.value
      .filter(item => item.scope === 'global')
      .sort((a, b) => a.priority - b.priority),
  )

  /** Per-session status bar items for a given sessionId, sorted by priority */
  function getSessionStatusBarItems(sessionId: string): PluginStatusItem[] {
    return statusBarItems.value
      .filter(item => item.scope === 'per-session' && item.sessionId === sessionId)
      .sort((a, b) => a.priority - b.priority)
  }

  /** Whether there are pending permission requests */
  const hasPendingPermissions = computed(() => permissionRequests.size > 0)

  // ── Notification queue ───────────────────────────────────────

  function addNotification(n: PluginNotification) {
    pluginNotifications.value = [n, ...pluginNotifications.value].slice(0, MAX_NOTIFICATIONS)
  }

  // ── Internal helpers ─────────────────────────────────────────

  /** Sync pluginStatuses map from installedPlugins array */
  function syncStatuses() {
    pluginStatuses.clear()
    for (const p of installedPlugins.value) {
      pluginStatuses.set(p.pluginId, p.status)
    }
  }

  /** Update a single plugin in installedPlugins by pluginId */
  function updatePluginField(pluginId: string, patch: Partial<PluginViewModel>) {
    const idx = installedPlugins.value.findIndex(p => p.pluginId === pluginId)
    if (idx !== -1) {
      installedPlugins.value[idx] = { ...installedPlugins.value[idx], ...patch }
    }
  }

  // ── Actions: WS send ─────────────────────────────────────────

  function fetchPlugins() {
    loading.value = true
    error.value = null
    send({ type: 'plugin.list', payload: {} })
  }

  /**
   * Toggle plugin enabled state (optimistic update).
   * Built-in plugins: no-op (cannot be disabled).
   */
  function togglePlugin(id: string, enabled: boolean) {
    const plugin = installedPlugins.value.find(p => p.pluginId === id)
    if (!plugin) return
    if (plugin.source === 'built-in') return

    // Optimistic update
    updatePluginField(id, { enabled, status: enabled ? 'active' : 'inactive' })
    pluginStatuses.set(id, enabled ? 'active' : 'inactive')

    send({
      type: 'plugin.toggle',
      payload: { pluginId: id, enabled },
    })
  }

  function uninstallPlugin(id: string) {
    const plugin = installedPlugins.value.find(p => p.pluginId === id)
    if (!plugin || plugin.source === 'built-in') return

    send({ type: 'plugin.uninstall', payload: { pluginId: id } })
  }

  function approvePermissions(id: string, permissions: string[]) {
    send({
      type: 'plugin.approvePermissions',
      payload: { pluginId: id, permissions },
    })
    permissionRequests.delete(id)
  }

  function revokePermissions(id: string) {
    send({
      type: 'plugin.revokePermissions',
      payload: { pluginId: id },
    })
  }

  function executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>) {
    send({
      type: 'plugin.executeCommand',
      payload: { pluginId, commandId, ...(args && { args }) },
    })
  }

  function getConfig(pluginId: string, key?: string) {
    send({
      type: 'plugin.config.get',
      payload: { pluginId, ...(key !== undefined && { key }) },
    })
  }

  function setConfig(pluginId: string, key: string, value: unknown) {
    send({
      type: 'plugin.config.set',
      payload: { pluginId, key, value },
    })
  }

  // ── Actions: event handlers (called by usePlugin composable) ─

  /** Replace full plugin list (from config.plugins response) */
  function setPlugins(plugins: PluginViewModel[]) {
    installedPlugins.value = plugins
    syncStatuses()
    loading.value = false
    error.value = null
  }

  /** Update a single plugin's status (from plugin:statusChange) */
  function setStatusChange(pluginId: string, newStatus: string) {
    pluginStatuses.set(pluginId, newStatus)
    updatePluginField(pluginId, {
      status: newStatus as PluginViewModel['status'],
    })
  }

  /** Mark plugin as crashed */
  function setCrashed(pluginId: string, errorMessage: string) {
    pluginStatuses.set(pluginId, 'crashed')
    updatePluginField(pluginId, { status: 'crashed', errorMessage })
    addNotification({ pluginId, level: 'error', message: errorMessage })
  }

  /** Set pending permission request */
  function setPermissionRequest(pluginId: string, permissions: string[]) {
    permissionRequests.set(pluginId, permissions)
  }

  /** Replace status bar items */
  function setStatusBarItems(items: PluginStatusItem[]) {
    statusBarItems.value = items
  }

  /** Set message decorations for a specific message */
  function setMessageDecorations(messageId: string, decorations: PluginMessageDecoration[]) {
    messageDecorations.set(messageId, decorations)
  }

  /** Update plugin config cache */
  function setPluginConfig(pluginId: string, config: Record<string, unknown>) {
    pluginConfigs.set(pluginId, config)
  }

  /** Set error state */
  function setError(err: string | null) {
    error.value = err
    if (err) loading.value = false
  }

  // ── Plugin lookup helper ─────────────────────────────────────

  function pluginById(id: string): PluginViewModel | undefined {
    return installedPlugins.value.find(p => p.pluginId === id)
  }

  return {
    // State
    installedPlugins,
    pluginStatuses,
    pluginNotifications,
    permissionRequests,
    statusBarItems,
    messageDecorations,
    pluginConfigs,
    loading,
    error,

    // Getters
    activePlugins,
    pluginList,
    builtInPlugins,
    externalPlugins,
    allSlashCommands,
    allStatusBarItems,
    globalStatusBarItems,
    hasPendingPermissions,

    // Actions: WS send
    fetchPlugins,
    togglePlugin,
    uninstallPlugin,
    approvePermissions,
    revokePermissions,
    executeCommand,
    getConfig,
    setConfig,

    // Actions: event handlers
    setPlugins,
    setStatusChange,
    setCrashed,
    setPermissionRequest,
    setStatusBarItems,
    setMessageDecorations,
    setPluginConfig,
    setError,
    addNotification,

    // Helpers
    pluginById,
    getSessionStatusBarItems,
  }
})
