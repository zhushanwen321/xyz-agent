import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WindowState, PanelTree } from '@xyz-agent/shared'

export const useWindowStore = defineStore('window', () => {
  const windows = ref<WindowState[]>([])
  const currentWindowId = ref<string>('')

  function refreshFromIPC() {
    if (window.electronAPI?.getWindows) {
      window.electronAPI.getWindows().then((wins) => {
        windows.value = wins as unknown as WindowState[]
      }).catch(() => {
        // ignore
      })
    }
  }

  async function createWindow(sessionId?: string) {
    if (!window.electronAPI?.createWindow) return
    const result = await window.electronAPI.createWindow(sessionId)
    refreshFromIPC()
    return result
  }

  function focusWindow(windowId: string) {
    window.electronAPI?.focusWindow?.(windowId)
  }

  function updateWindowState(state: Partial<WindowState>) {
    if (!currentWindowId.value) return
    window.electronAPI?.updateWindowState?.(currentWindowId.value, state)
  }

  /** Sync local pane tree to main process */
  function syncPaneState(panelTree: PanelTree, focusedPanelId: string) {
    // Strip Vue reactivity proxy before IPC serialization
    const plain = JSON.parse(JSON.stringify(panelTree))
    updateWindowState({ panelTree: plain, focusedPanelId })
  }

  return {
    windows,
    currentWindowId,
    refreshFromIPC,
    createWindow,
    focusWindow,
    updateWindowState,
    syncPaneState,
  }
})
