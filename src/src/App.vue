<template>
  <div :class="['app', { 'focus-mode': settingsStore.focusMode }]">
    <AppHeader />
    <div class="app-body">
      <AppSidebar v-if="!settingsStore.focusMode" @create="createSession" />
      <main class="main-area">
        <ChatView v-if="settingsStore.currentView === 'chat'" />
      </main>
    </div>
    <AppStatusbar />
    <Toaster position="top-right" :theme="settingsStore.theme" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Toaster } from 'vue-sonner'
import { listen } from '@tauri-apps/api/event'
import { useSettingsStore } from './stores/settings'
import { useConnection } from './composables/useConnection'
import AppHeader from './components/layout/AppHeader.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import ChatView from './components/chat/ChatView.vue'

const { init: initConnection, teardown: teardownConnection } = useConnection()

const settingsStore = useSettingsStore()

function createSession() {
  // TODO: implement via useSession composable
  console.log('create session')
}

onMounted(async () => {
  // Initialise WebSocket connection to sidecar
  initConnection()

  try {
    await listen<string>('shortcut', (event) => {
      switch (event.payload) {
        case 'standard':
          settingsStore.focusMode = false
          settingsStore.currentView = 'chat'
          break
        case 'focus':
          settingsStore.toggleFocus()
          break
        case 'settings':
          // Open settings in a new window instead of inline
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('open_settings_window')
          }).catch(() => {
            // Fallback: switch view inline if not in Tauri
            settingsStore.setView(settingsStore.currentView === 'settings' ? 'chat' : 'settings')
          })
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
.app.focus-mode .sidebar { display: none; }
.app-body { display: flex; flex: 1; overflow: hidden; }
.main-area { flex: 1; display: flex; min-width: 0; overflow: hidden; }
</style>
