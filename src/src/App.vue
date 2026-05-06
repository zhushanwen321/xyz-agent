<template>
  <div :class="['app', { 'focus-mode': settingsStore.focusMode }]">
    <AppHeader />
    <div class="app-body">
      <AppSidebar v-if="!settingsStore.focusMode" @create="createSession" />
      <main class="main-area">
        <ChatView v-if="settingsStore.currentView === 'chat'" />
        <SettingsView v-else-if="settingsStore.currentView === 'settings'" />
      </main>
    </div>
    <AppStatusbar />
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from './stores/settings'
import AppHeader from './components/layout/AppHeader.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import ChatView from './components/chat/ChatView.vue'
import SettingsView from './components/layout/SettingsView.vue'

const settingsStore = useSettingsStore()

function createSession() {
  // TODO: implement via useSession composable
  console.log('create session')
}
</script>

<style>
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.app.focus-mode .sidebar { display: none; }
.app-body { display: flex; flex: 1; overflow: hidden; }
.main-area { flex: 1; display: flex; min-width: 0; overflow: hidden; }
</style>
