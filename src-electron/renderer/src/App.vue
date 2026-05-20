<template>
  <div class="flex flex-col h-screen overflow-hidden">
    <AppHeader @toggle-sidebar="toggleSidebar" />
    <div class="flex flex-1 overflow-hidden relative">
      <AppSidebar :visible="sidebarVisible" @create="createSession" @close="sidebarVisible = false" />
      <main class="flex-1 flex min-w-0 overflow-hidden relative">
        <SettingsView v-if="settingsStore.currentView === 'settings'" />
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
    </div>
    <AppStatusbar />
    <!-- PanelGrid -->
    <PanelGrid
      :visible="settingsStore.panelGridVisible"
      @close="settingsStore.panelGridVisible = false"
    />
    <!-- Sidebar backdrop -->
    <div v-if="sidebarVisible" class="sidebar-backdrop" @click="sidebarVisible = false" />
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
import { useConnection } from './composables/useConnection'
import { getState as getWsState } from './lib/ws-client'
import { useProvider } from './composables/useProvider'
import { useSession } from './composables/useSession'
import type { ToastItem } from './components/toast/ToastContainer.vue'
import AppHeader from './components/layout/AppHeader.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import SettingsView from './components/layout/SettingsView.vue'
import PanelTreeRenderer from './components/panel/PanelTreeRenderer.vue'
import DrawerOverlay from './components/panel/DrawerOverlay.vue'
import InspectorRight from './components/side-inspector/InspectorRight.vue'
import InspectorLeft from './components/side-inspector/InspectorLeft.vue'
import PanelGrid from './components/panel-grid/PanelGrid.vue'
import ToastContainer from './components/toast/ToastContainer.vue'
// Data comes from WS events via composables/stores — no mock imports

const { init: initConnection, teardown: teardownConnection } = useConnection()
// useProvider listens for WS config.provider* / model.* events
useProvider()
const { loadSessions, createSession: doCreateSession, switchSession } = useSession()

const settingsStore = useSettingsStore()
const panelStore = usePanelStore()
const sessionStore = useSessionStore()
const windowStore = useWindowStore()

const toasts = ref<ToastItem[]>([])
const TOAST_DURATION_MS = 4_000
const sidebarVisible = ref(false)

// 创建 session 后自动跳转：监听 session 数量变化
let isCreatingFromSidebar = false
let prevSessionCount = 0

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value
  // 与通知 Drawer 互斥：sidebar 打开时关闭通知 drawer
  if (sidebarVisible.value) {
    settingsStore.closeInspector()
  }
}

// Global keyboard shortcut handler (Vue-level, for keys not registered in Electron)
function handleKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  switch (e.key) {
    case 'w':
      e.preventDefault()
      panelStore.unbindSession(panelStore.focusedPanelId)
      break
    case 'b':
      e.preventDefault()
      toggleSidebar()
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
  // Open directory picker dialog
  if (!window.electronAPI?.pickDirectory) {
    console.warn('[createSession] pickDirectory API not available — rebuild preload with: cd src-electron && npm run build:preload')
    return
  }
  const result = await window.electronAPI.pickDirectory({ title: '选择项目目录' })
  if (result.canceled || !result.path) return

  const label = sessionStore.generateSessionLabel(result.path)
  isCreatingFromSidebar = true
  prevSessionCount = sessionStore.sessions.length
  doCreateSession(result.path, label)
}

function dismissToast(id: string) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}


onMounted(async () => {
  await initConnection()

  // Wait for WebSocket connection before loading sessions
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

  // 恢复主题和 palette 到 DOM
  settingsStore.applyTheme()

  // ── 创建 session 后自动跳转到新 session ──
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

  // ── 多窗口初始化 ────────────────────────────────────────────────
  // 从 URL query 读取 windowId 和 sessionId（由 main.ts createWindow 传入）
  const params = new URLSearchParams(window.location.search)
  const queryWindowId = params.get('windowId')
  const querySessionId = params.get('sessionId')

  if (queryWindowId) {
    windowStore.currentWindowId = queryWindowId
  }
  if (querySessionId) {
    panelStore.bindSession(panelStore.focusedPanelId, querySessionId)
  }

  // ── Sync pane state to main process on changes ──
  watch(
    () => [panelStore.tree, panelStore.focusedPanelId] as const,
    ([tree, focusedPanelId]) => {
      windowStore.syncPaneState(tree, focusedPanelId)
    },
    { deep: true },
  )

  // ── Listen for window list changes to keep overview fresh ──
  if (window.electronAPI?.onWindowListUpdated) {
    window.electronAPI.onWindowListUpdated(() => {
      windowStore.refreshFromIPC()
    })
  }

  // ── Electron IPC: 监听快捷键事件
  if (window.electronAPI) {
    window.electronAPI.onShortcut((type) => {
      switch (type) {
        case 'standard':
        case 'focus':
          panelStore.mergeToSingle()
          settingsStore.currentView = 'chat'
          break
        case 'split':
          panelStore.splitPanel(panelStore.focusedPanelId, 'horizontal')
          break
        case 'overview':
          settingsStore.togglePanelGrid()
          break
        case 'settings':
          settingsStore.setView(settingsStore.currentView === 'settings' ? 'chat' : 'settings')
          break
      }
    })
  }

  // Global keyboard listener for keys not registered in Electron
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  teardownConnection()
})
</script>

<style>
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgba(0, 0, 0, 0.3);
}
</style>
