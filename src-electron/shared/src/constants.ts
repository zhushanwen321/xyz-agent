/**
 * Shared constants used by both runtime (Node.js) and renderer (Electron).
 * Single source of truth — import from here, never hardcode.
 */

/** Base port for the runtime WebSocket server */
// eslint-disable-next-line no-magic-numbers
export const BASE_PORT = 3210 as const

/** Port offset used in dev mode to avoid connecting to prod runtime */
// eslint-disable-next-line no-magic-numbers
export const DEV_PORT_OFFSET = 100 as const

/** Maximum valid port number */
// eslint-disable-next-line no-magic-numbers
export const MAX_PORT = 65535 as const

/** Environment variable prefixes allowed to pass to child processes */
export const ENV_WHITELIST_PREFIXES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'TERM',
  'NODE_', 'NVM_', 'XYZ_', 'XDG_',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP',
]
