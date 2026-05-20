import { computed } from 'vue'
import { connect, disconnect, getState } from '../lib/ws-client'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

const DEFAULT_PORT = 3210

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
}

let initialised = false
let removeRuntimePortListener: (() => void) | null = null

export function useConnection() {
  const state = getState()

  const status = computed(() => state.value as ConnectionStatus)
  const isConnected = computed(() => state.value === 'connected')
  const statusText = computed(() => STATUS_TEXT[status.value] ?? status.value)

  async function init(): Promise<void> {
    if (initialised) return
    initialised = true

    if (import.meta.env.VITE_MOCK === 'true') {
      connect('mock://localhost')
      return
    }

    const port = DEFAULT_PORT

    try {
      // Electron IPC: 监听 runtime 端口事件
      if (window.electronAPI) {
        removeRuntimePortListener = window.electronAPI.onRuntimePort((newPort) => {
          if (newPort && state.value !== 'disconnected') {
            disconnect()
            connect(`ws://localhost:${newPort}`)
          }
        })

        // 尝试从主进程获取已知端口
        try {
          const knownPort = await window.electronAPI.getRuntimePort()
          if (knownPort) {
            connect(`ws://localhost:${knownPort}`)
            return
          }
        // eslint-disable-next-line taste/no-silent-catch -- intentional: runtime may not be ready yet, fall through to default port
        } catch (e) {
          console.error('[useConnection] runtime port not ready:', e)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- intentional: fall back to default port when Electron API is unavailable
    } catch (e) {
      console.error('[useConnection] Electron API unavailable, using default port:', e)
    }

    connect(`ws://localhost:${port}`)
  }

  function teardown(): void {
    if (removeRuntimePortListener) {
      removeRuntimePortListener()
      removeRuntimePortListener = null
    }
    disconnect()
    initialised = false
  }

  return { state, status, isConnected, statusText, init, teardown, disconnect }
}
