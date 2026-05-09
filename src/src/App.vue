<template>
  <div :class="['app', { 'focus-mode': settingsStore.focusMode }]">
    <AppHeader />
    <div class="app-body">
      <AppSidebar v-if="!settingsStore.focusMode" @create="createSession" />
      <main class="main-area">
        <SettingsView v-if="settingsStore.currentView === 'settings'" />
        <template v-else>
          <ChatView />
          <!-- Split mode -->
          <template v-if="settingsStore.splitMode">
            <SplitDivider @resize="handleSplitResize" />
            <ChatView />
          </template>
        </template>
        <!-- Drawers -->
        <DrawerOverlay :visible="settingsStore.drawerOpen" @close="settingsStore.closeDrawer()" />
        <DrawerRight
          v-if="settingsStore.drawerSide === 'right'"
          :open="settingsStore.drawerOpen"
          :tree-nodes="[]"
          :done-items="[]"
          :alert-items="[]"
          active-node-id=""
          @close="settingsStore.closeDrawer()"
        />
        <DrawerLeft
          v-if="settingsStore.splitMode && settingsStore.drawerSide === 'left'"
          :open="settingsStore.drawerOpen"
          :tree-nodes="[]"
          :done-items="[]"
          :alert-items="[]"
          active-node-id=""
          @close="settingsStore.closeDrawer()"
        />
      </main>
    </div>
    <AppStatusbar />
    <!-- Overview -->
    <Overview
      :visible="settingsStore.overviewVisible"
      :cards="[]"
      @enter="handleOverviewEnter"
      @enter-split="handleOverviewEnterSplit"
      @close="settingsStore.overviewVisible = false"
    />
    <!-- Custom Toast -->
    <ToastContainer :toasts="toasts" @dismiss="dismissToast" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { useSettingsStore } from './stores/settings'
import { invoke } from '@tauri-apps/api/core'
import { useConnection } from './composables/useConnection'
import { useProvider } from './composables/useProvider'
import { useSession } from './composables/useSession'
import type { ToastItem } from './components/toast/ToastContainer.vue'
import AppHeader from './components/layout/AppHeader.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import ChatView from './components/chat/ChatView.vue'
import SettingsView from './components/layout/SettingsView.vue'
import SplitDivider from './components/panel/SplitDivider.vue'
import DrawerOverlay from './components/panel/DrawerOverlay.vue'
import DrawerRight from './components/drawer/DrawerRight.vue'
import DrawerLeft from './components/drawer/DrawerLeft.vue'
import Overview from './components/overview/Overview.vue'
import ToastContainer from './components/toast/ToastContainer.vue'
// Data comes from WS events via composables/stores — no mock imports

const { init: initConnection, teardown: teardownConnection } = useConnection()
// useProvider listens for WS config.provider* / model.* events
useProvider()
const { loadSessions, createSession: doCreateSession } = useSession()

const settingsStore = useSettingsStore()

const toasts = ref<ToastItem[]>([])

async function createSession() {
  try {
    const result = await invoke<{ path: string | null; cancelled: boolean }>('pick_folder')
    console.log('[createSession] pick_folder result:', result)
    if (result.cancelled || !result.path) return
    console.log('[createSession] creating session with cwd:', result.path)
    doCreateSession(result.path)
  } catch (e) {
    console.error('[createSession] Failed to pick folder:', e)
  }
}

function dismissToast(id: string) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}

function handleOverviewEnter(_id: string) { // eslint-disable-line @typescript-eslint/no-unused-vars
  settingsStore.overviewVisible = false
}

function handleOverviewEnterSplit(_id: string) { // eslint-disable-line @typescript-eslint/no-unused-vars
  settingsStore.splitMode = true
  settingsStore.overviewVisible = false
}

function handleSplitResize(_delta: number) { // eslint-disable-line @typescript-eslint/no-unused-vars
  // TODO: resize split panels
}

onMounted(async () => {
  // Initialise WebSocket connection to sidecar
  initConnection()

  // Load sessions after connection
  loadSessions()

  try {
    await listen<string>('shortcut', (event) => {
      switch (event.payload) {
        case 'standard':
          settingsStore.focusMode = false
          settingsStore.splitMode = false
          settingsStore.currentView = 'chat'
          break
        case 'split':
          settingsStore.splitMode = !settingsStore.splitMode
          break
        case 'focus':
          settingsStore.toggleFocus()
          break
        case 'overview':
          settingsStore.toggleOverview()
          break
        case 'settings':
          settingsStore.setView(settingsStore.currentView === 'settings' ? 'chat' : 'settings')
          break
      }
    })
    // eslint-disable-next-line taste/no-silent-catch -- expected in browser dev mode, no Tauri runtime
  } catch {
    console.warn('[App] Non-Tauri environment, shortcuts unavailable')
  }
})

onUnmounted(() => {
  teardownConnection()
})
</script>

<style>
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.app.focus-mode .sidebar { width: 0; border-right: none; overflow: hidden; }
.app.focus-mode .statusbar { display: none; }
.app.focus-mode .chat-msgs { max-width: 720px; margin: 0 auto; width: 100%; }
.app-body { display: flex; flex: 1; overflow: hidden; position: relative; }
.main-area { flex: 1; display: flex; min-width: 0; overflow: hidden; position: relative; }
</style>
