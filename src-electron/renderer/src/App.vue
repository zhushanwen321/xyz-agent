<template>
  <div ref="appContainer" class="app-container" :class="{ 'app-container--sidebar-collapsed': sidebarStore.collapsed }">
    <!-- Sidebar: unified with controls -->
    <AppSidebar
      @create="createSession"
      @toggle-panel-grid="settingsStore.togglePanelGrid()"
      @toggle-settings="toggleSettings()"
    />
    <!-- Content area -->
    <main class="content-area">
      <SettingsView v-if="navStore.currentView === 'settings'" />
      <PanelTreeRenderer v-else
        :node="panelStore.tree"
        :focused-panel-id="panelStore.focusedPanelId"
      />
      <!-- Drawers -->
      <DrawerOverlay :visible="settingsStore.inspectorOpen" @close="settingsStore.closeInspector()" />
      <InspectorRight
        v-if="settingsStore.inspectorSide === 'right'"
        :open="settingsStore.inspectorOpen"
        :tree-nodes="[]"
        :done-items="[]"
        :alert-items="[]"
        active-node-id=""
        @close="settingsStore.closeInspector()"
      />
      <InspectorLeft
        v-if="panelStore.panelCount > 1 && settingsStore.inspectorSide === 'left'"
        :open="settingsStore.inspectorOpen"
        :tree-nodes="[]"
        :done-items="[]"
        :alert-items="[]"
        active-node-id=""
        @close="settingsStore.closeInspector()"
      />
    </main>
    <!-- Global Statusbar: spans entire width -->
    <AppStatusbar />
    <!-- PanelGrid -->
    <PanelGrid
      :visible="settingsStore.panelGridVisible"
      @close="settingsStore.panelGridVisible = false"
    />
    <!-- Extension UI Dialog -->
    <ExtensionUIDialog />
    <!-- Custom Toast -->
    <ToastContainer :toasts="toasts" @dismiss="dismissToast" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from './stores/settings'
import { usePanelStore } from './stores/panel'
import { useSessionStore } from './stores/session'
import { useWindowStore } from './stores/window'
import { useNavigationStore } from './stores/navigation'
import { useSidebarStore } from './stores/sidebar'
import { useLayoutStore } from './stores/layout'
import { useConnection } from './composables/useConnection'
import { getState as getWsState } from './lib/ws-client'
import { on as onEventBus, off as offEventBus } from './lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'
import { useProvider } from './composables/useProvider'
import { useSession } from './composables/useSession'
import type { ToastItem } from './components/toast/ToastContainer.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import SettingsView from './components/layout/SettingsView.vue'
import PanelTreeRenderer from './components/panel/PanelTreeRenderer.vue'
import DrawerOverlay from './components/panel/DrawerOverlay.vue'
import InspectorRight from './components/side-inspector/InspectorRight.vue'
import InspectorLeft from './components/side-inspector/InspectorLeft.vue'
import PanelGrid from './components/panel-grid/PanelGrid.vue'
import ToastContainer from './components/toast/ToastContainer.vue'
import ExtensionUIDialog from './components/extension/ExtensionUIDialog.vue'

const { init: initConnection, teardown: teardownConnection } = useConnection()
useProvider()
const { loadSessions, createSession: doCreateSession, switchSession } = useSession()

const appContainer = ref<HTMLElement | null>(null)

const settingsStore = useSettingsStore()
const panelStore = usePanelStore()
const sessionStore = useSessionStore()
const windowStore = useWindowStore()
const navStore = useNavigationStore()
const sidebarStore = useSidebarStore()
const layoutStore = useLayoutStore()


// Unified settings toggle — used by sidebar emit and IPC shortcut
function toggleSettings() {
  if (navStore.currentView === 'settings') {
    if (navStore.canGoBack) { navStore.back() } else { navStore.reset() }
  } else {
    navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() })
  }
}

// Sync panel focus when navigation changes to a different chat session
watch(
  () => navStore.currentEntry?.view === 'chat' ? navStore.currentEntry.sessionId : null,
  (sessionId) => {
    if (sessionId && panelStore.focusedPanel?.sessionId !== sessionId) {
      panelStore.openSessionSmart(sessionId)
    }
  },
)

const toasts = ref<ToastItem[]>([])
const TOAST_DURATION_MS = 4_000
const TOAST_LONG_DURATION_MS = 8_000
const WS_DISCONNECT_WARN_DELAY_MS = 10_000

let wsDisconnectTimer: ReturnType<typeof setTimeout> | null = null
const wsState = getWsState()
const wsStateUnwatch = watch(wsState, (newState) => {
  if (newState === 'disconnected' || newState === 'reconnecting') {
    if (!wsDisconnectTimer) {
      wsDisconnectTimer = setTimeout(() => {
        const id = crypto.randomUUID()
        toasts.value.push({
          id,
          type: 'warning',
          title: '连接已断开',
          description: 'Runtime 连接已断开，正在尝试重新连接…',
        })
        setTimeout(() => dismissToast(id), TOAST_LONG_DURATION_MS)
      }, WS_DISCONNECT_WARN_DELAY_MS)
    }
  } else if (newState === 'connected') {
    if (wsDisconnectTimer) {
      clearTimeout(wsDisconnectTimer)
      wsDisconnectTimer = null
    }
  }
})
const ipcCleanupFns: Array<() => void> = []
let extTimeoutUnregister: (() => void) | null = null
let errorUnregister: (() => void) | null = null

let isCreatingFromSidebar = false
let prevSessionCount = 0

function handleKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  switch (e.key) {
    case 'w':
      e.preventDefault()
      panelStore.unbindSession(panelStore.focusedPanelId)
      break
    case 'd':
      e.preventDefault()
      const dir = e.shiftKey ? 'vertical' : 'horizontal'
      if (!panelStore.splitPanel(panelStore.focusedPanelId, dir)) {
        const id = crypto.randomUUID()
        toasts.value.push({
          id,
          type: 'warning',
          title: '已达面板数量上限',
          description: '最多支持 4 个面板，请先关闭空闲面板后再拆分。',
        })
        setTimeout(() => dismissToast(id), TOAST_DURATION_MS)
      }
      break
  }
}

async function createSession() {
  if (!window.electronAPI?.pickDirectory) {
    console.warn('[createSession] pickDirectory API not available')
    return
  }
  const result = await window.electronAPI.pickDirectory({ title: '选择项目目录' })
  if (result.canceled || !result.path) return

  const label = sessionStore.generateSessionLabel(result.path)
  isCreatingFromSidebar = true
  prevSessionCount = sessionStore.sessions.length
  doCreateSession(result.path, label)
}

function handleGlobalError(msg: ServerMessage) {
  if (!msg.payload.sessionId) {
    const id = crypto.randomUUID()
    toasts.value.push({
      id,
      type: 'danger',
      title: '操作失败',
      description: (msg.payload.message as string) ?? '未知错误',
    })
    setTimeout(() => dismissToast(id), TOAST_LONG_DURATION_MS)
  }
}

function dismissToast(id: string) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}

onMounted(async () => {
  await initConnection()

  const wsState = getWsState()
  if (wsState.value === 'connected') {
    loadSessions()
  } else {
    const stopWatch = watch(wsState, (val) => {
      if (val === 'connected') {
        stopWatch()
        loadSessions()
      }
    })
  }

  settingsStore.applyTheme()

  watch(
    () => sessionStore.sessions.length,
    (newLen) => {
      if (isCreatingFromSidebar && newLen > prevSessionCount && sessionStore.sessions.length > 0) {
        isCreatingFromSidebar = false
        const newest = sessionStore.sessions[0]
        if (newest) {
          switchSession(newest.id)
          panelStore.openSessionSmart(newest.id)
        }
      }
    },
  )

  const params = new URLSearchParams(window.location.search)
  const queryWindowId = params.get('windowId')
  const querySessionId = params.get('sessionId')

  if (queryWindowId) {
    windowStore.currentWindowId = queryWindowId
  }
  if (querySessionId) {
    panelStore.bindSession(panelStore.focusedPanelId, querySessionId)
  }

  watch(
    () => [panelStore.tree, panelStore.focusedPanelId] as const,
    ([tree, focusedPanelId]) => {
      windowStore.syncPaneState(tree, focusedPanelId)
    },
    { deep: true },
  )

  if (window.electronAPI?.onWindowListUpdated) {
    ipcCleanupFns.push(window.electronAPI.onWindowListUpdated(() => {
      windowStore.refreshFromIPC()
    }))
  }

  if (window.electronAPI) {
    ipcCleanupFns.push(window.electronAPI.onShortcut((type) => {
      switch (type) {
        case 'standard':
        case 'focus':
          panelStore.mergeToSingle()
          if (navStore.currentView !== 'chat') {
            const sid = panelStore.focusedPanel?.sessionId ?? ''
            if (sid) navStore.push({ view: 'chat', sessionId: sid })
          }
          break
        case 'split':
          panelStore.splitPanel(panelStore.focusedPanelId, 'horizontal')
          break
        case 'overview':
          settingsStore.togglePanelGrid()
          break
        case 'settings':
          toggleSettings()
          break
      }
    }))
  }

  document.addEventListener('keydown', handleKeydown)

  if (window.electronAPI?.onRuntimeError) {
    ipcCleanupFns.push(window.electronAPI.onRuntimeError((error) => {
      const id = crypto.randomUUID()
      toasts.value.push({
        id,
        type: 'danger',
        title: 'Runtime 启动失败',
        description: error.message,
      })
      setTimeout(() => dismissToast(id), TOAST_LONG_DURATION_MS)
    }))
  }

  let disconnectToastId: string | null = null
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null
  const wsWatchState = getWsState()
  watch(wsWatchState, (state) => {
    if (state === 'disconnected' || state === 'reconnecting') {
      if (!disconnectToastId && !disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null
          if (wsWatchState.value !== 'connected' && !disconnectToastId) {
            disconnectToastId = crypto.randomUUID()
            toasts.value.push({
              id: disconnectToastId,
              type: 'warning',
              title: '连接断开',
              description: '正在尝试重新连接 Runtime 服务…',
            })
          }
        }, WS_DISCONNECT_WARN_DELAY_MS)
      }
    } else if (state === 'connected') {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer)
        disconnectTimer = null
      }
      if (disconnectToastId) {
        dismissToast(disconnectToastId)
        disconnectToastId = null
      }
    }
  })

  // extension UI timeout → toast
  extTimeoutUnregister = onEventBus('extension.ui_timed_out', (payload: { extensionName: string }) => {
    const id = crypto.randomUUID()
    toasts.value.push({
      id,
      type: 'warning',
      title: 'Extension 请求超时',
      description: `${payload.extensionName} 的 UI 请求已超时`,
    })
    setTimeout(() => dismissToast(id), TOAST_DURATION_MS)
  })

  errorUnregister = onEventBus('error', handleGlobalError)

  // macOS fullscreen state → toggle .is-fullscreen class on root element AND sync to layout store
  if (window.electronAPI?.onFullscreenChanged) {
    ipcCleanupFns.push(window.electronAPI.onFullscreenChanged(({ isFullscreen }) => {
      layoutStore.setFullscreen(isFullscreen)
      if (appContainer.value) {
        if (isFullscreen) {
          appContainer.value.classList.add('is-fullscreen')
        } else {
          appContainer.value.classList.remove('is-fullscreen')
        }
      }
    }))
  }
})

onUnmounted(() => {
  offEventBus('error', handleGlobalError)
  extTimeoutUnregister?.()
  errorUnregister?.()
  document.removeEventListener('keydown', handleKeydown)
  wsStateUnwatch()
  if (wsDisconnectTimer) clearTimeout(wsDisconnectTimer)
  for (const cleanup of ipcCleanupFns) cleanup()
  ipcCleanupFns.length = 0
  teardownConnection()
})
</script>

<style>
.app-container {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: 1fr auto;
  height: 100vh;
  overflow: hidden;
}
.content-area {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background: var(--bg);
}
</style>
