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
let removeSidecarPortListener: (() => void) | null = null

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
      // Electron IPC: 监听 sidecar 端口事件
      if (window.electronAPI) {
        removeSidecarPortListener = window.electronAPI.onSidecarPort((newPort) => {
          if (newPort && state.value !== 'disconnected') {
            disconnect()
            connect(`ws://localhost:${newPort}`)
          }
        })

        // 尝试从主进程获取已知端口
        try {
          const knownPort = await window.electronAPI.getSidecarPort()
          if (knownPort) {
            connect(`ws://localhost:${knownPort}`)
            return
          }
        } catch {
          // 主进程尚未准备好
        }
      }
    } catch {
      console.warn('[useConnection] Electron API unavailable, using default port')
    }

    connect(`ws://localhost:${port}`)
  }

  function teardown(): void {
    if (removeSidecarPortListener) {
      removeSidecarPortListener()
      removeSidecarPortListener = null
    }
    disconnect()
    initialised = false
  }

  return { state, status, isConnected, statusText, init, teardown, disconnect }
}
