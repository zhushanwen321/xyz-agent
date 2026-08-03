/**
 * extension-host —— ExtensionHost 基建与注册中心（W1 barrel）。
 *
 * 只 export W1 已交付模块（types/InternalEventBus/createSessionScopedMap/MountPointRegistry/
 * ContributionRegistry/builtinContributions/PluginMessageSource+MockMessageSource）。
 * message-bus-bridge / command-registry / activation-manager / status-bar-controller /
 * overlay-lifecycle / view-host-store 等由 w2-w4 交付后追加，不引用未建文件。
 */
export * from './types'
export { InternalEventBus } from './internal-event-bus'
export { createSessionScopedMap } from './utils/session-scoped-map'
export type { SessionScopedMap } from './utils/session-scoped-map'
export { MountPointRegistry } from './mount-point-registry'
export type { MountPointHost } from './mount-point-registry'
export { ContributionRegistry } from './contribution-registry'
export { builtinContributions } from './builtin-contributions'
export { MockMessageSource } from './plugin-message-source'
export type { PluginMessageSource, IncomingPluginMessage } from './plugin-message-source'
