/**
 * Plugin System — Frontend type definitions.
 *
 * Mirrors / extends types from shared/protocol.ts (which aren't re-exported from the shared barrel).
 * These types are the single source of truth for the renderer process.
 */

// ── Status bar ────────────────────────────────────────────────

export interface PluginStatusItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
}

// ── Message decoration ────────────────────────────────────────

export interface PluginMessageDecoration {
  type: string
  pluginId: string
  label: string
  color?: string
  commandId?: string
}

// ── Setting schema ────────────────────────────────────────────

export interface PluginSettingSchema {
  key: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path'
  label: string
  description?: string
  default?: unknown
  enumValues?: Array<{ label: string; value: string }>
  requiresRestart?: boolean
}

// ── Contributes (manifest contributions) ───────────────────────

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string }>
  hooks?: string[]
  panels?: Array<{ id: string; title: string; view: string }>
  statusBarItems?: Array<{ id: string; text: string; priority: number }>
  settings?: PluginSettingSchema[]
}

// ── Plugin view model (front-end full view) ────────────────────

export interface PluginViewModel {
  pluginId: string
  displayName: string
  version: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  source: 'built-in' | 'external'
  enabled: boolean
  permissions: string[]
  errorMessage?: string
  contributes?: PluginContributes
}

// ── Notification ──────────────────────────────────────────────

export interface PluginNotification {
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}
