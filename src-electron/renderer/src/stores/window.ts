import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WindowState, PanelTree } from '@xyz-agent/shared'
import { api } from '@/api'

export const useWindowStore = defineStore('window', () => {
  const windows = ref<WindowState[]>([])
  const currentWindowId = ref<string>('')

  function refreshFromIPC() {
    api.window.list().then((wins) => {
      if (wins) windows.value = wins
    }).catch(() => {
      // ignore
    })
  }

  async function createWindow(sessionId?: string) {
    const result = await api.window.create(sessionId)
    refreshFromIPC()
    return result
  }

  function focusWindow(windowId: string) {
    api.window.focus(windowId)
  }

  /** 检查指定 session 是否已在其他窗口打开 */
  async function findSessionWindow(sessionId: string): Promise<{ windowId: string } | null> {
    return api.window.findSession(sessionId)
  }

  function updateWindowState(state: Partial<WindowState>) {
    if (!currentWindowId.value) return
    api.window.updateState(currentWindowId.value, state)
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
    findSessionWindow,
    updateWindowState,
    syncPaneState,
  }
})
