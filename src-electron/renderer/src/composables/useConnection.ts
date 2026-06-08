import { computed } from 'vue'
import { connect, disconnect, getState } from '../lib/ws-client'
import { BASE_PORT } from '@xyz-agent/shared'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** 获取实际的 fallback 端口（考虑 dev 模式的端口偏移） */
async function resolveFallbackPort(): Promise<number> {
  try {
    if (window.electronAPI) {
      const offset = await window.electronAPI.getRuntimePortOffset()
      return BASE_PORT + offset
    }
  // eslint-disable-next-line taste/no-silent-catch
  } catch {
    // IPC 不可用，使用 base port
  }
  return BASE_PORT
}

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
    if (initialised) {
      // HMR 后重连——connect() 内部有去重逻辑
      if (import.meta.env.VITE_MOCK !== 'true') {
        const port = await resolveFallbackPort()
        connect('ws://localhost:' + port)
      }
      return
    }
    initialised = true

    if (import.meta.env.VITE_MOCK === 'true') {
      connect('mock://localhost')
      return
    }

    try {
      // Electron IPC: 监听 runtime 端口事件
      if (window.electronAPI) {
        removeRuntimePortListener = window.electronAPI.onRuntimePort((newPort) => {
          if (newPort) {
            disconnect()
            connect('ws://localhost:' + newPort)
          }
        })

        // 尝试从主进程获取已知端口
        try {
          const knownPort = await window.electronAPI.getRuntimePort()
          if (knownPort) {
            connect('ws://localhost:' + knownPort)
            return
          }
        // eslint-disable-next-line taste/no-silent-catch
        } catch (e) {
          console.error('[useConnection] runtime port not ready:', e)
        }

        // Runtime 尚未启动时，用偏移后的端口做 fallback（避免连到 prod runtime）
        const fallbackPort = await resolveFallbackPort()
        connect('ws://localhost:' + fallbackPort)
        return
      }
    // eslint-disable-next-line taste/no-silent-catch
    } catch (e) {
      console.error('[useConnection] Electron API unavailable:', e)
    }

    // 没有 Electron API（Web 模式），用 base port
    connect('ws://localhost:' + BASE_PORT)
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
