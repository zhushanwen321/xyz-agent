import { connect, disconnect, getState } from '../lib/ws-client'

export function useConnection() {
  const state = getState()

  function connectToSidecar(port: number) {
    connect(`ws://localhost:${port}`)
  }

  function disconnectFromSidecar() {
    disconnect()
  }

  return { state, connectToSidecar, disconnectFromSidecar }
}
