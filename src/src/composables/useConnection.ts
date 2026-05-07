import { computed } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { connect, disconnect, getState } from '../lib/ws-client'
import type { UnlistenFn } from '@tauri-apps/api/event'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

const DEFAULT_PORT = 3210

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
}

let initialised = false
let unlistenSidecarPort: UnlistenFn | null = null

export function useConnection() {
  const state = getState()

  const status = computed(() => state.value as ConnectionStatus)
  const isConnected = computed(() => state.value === 'connected')
  const statusText = computed(() => STATUS_TEXT[status.value] ?? status.value)

  /**
   * Initialise the connection:
   * 1. Try to listen for the `sidecar-port` Tauri event (sent by the Rust sidecar launcher).
   * 2. If the event has already been emitted before we start listening, fall back to the default port.
   * 3. Connect the ws-client to `ws://localhost:<port>`.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async function init(): Promise<void> {
    if (initialised) return
    initialised = true

    const port = DEFAULT_PORT

    try {
      const unlisten = await listen<number>('sidecar-port', (event) => {
        // If we receive the port event after already connecting,
        // reconnect with the correct port.
        const newPort = event.payload
        if (newPort && state.value !== 'disconnected') {
          disconnect()
          connect(`ws://localhost:${newPort}`)
        }
      })
      unlistenSidecarPort = unlisten

      // The sidecar may have already emitted the port event before we
      // started listening.  We optimistically connect with the default;
      // if the sidecar is still starting, ws-client's reconnect loop will
      // eventually succeed.
    // eslint-disable-next-line taste/no-silent-catch -- expected outside Tauri runtime, fallback to default port
    } catch {
      // Not running inside Tauri (e.g. `vite dev` in browser)
      console.warn('[useConnection] Tauri event listener unavailable, using default port')
    }

    connect(`ws://localhost:${port}`)
  }

  /**
   * Gracefully tear down the connection.
   */
  function teardown(): void {
    if (unlistenSidecarPort) {
      unlistenSidecarPort()
      unlistenSidecarPort = null
    }
    disconnect()
    initialised = false
  }

  return { state, status, isConnected, statusText, init, teardown, disconnect }
}
