<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import Topbar from './components/Topbar.vue'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'
import { useSession } from './composables/useSession'
import { checkApiKey } from './lib/tauri'

const { currentSessionId } = useSession()
const sidebarCollapsed = ref(false)
const currentPage = ref<'chat' | 'settings'>('chat')
const apiKeyMissing = ref(false)

onMounted(async () => {
  try {
    const configured = await checkApiKey()
    if (!configured) {
      apiKeyMissing.value = true
      currentPage.value = 'settings'
    }
  } catch {
    apiKeyMissing.value = true
    currentPage.value = 'settings'
  }
})

function onConfigApplied() {
  apiKeyMissing.value = false
  currentPage.value = 'chat'
}
</script>

<template>
  <div class="flex h-screen flex-col bg-surface text-foreground">
    <Topbar
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @navigate="(page) => { currentPage = page }"
    />

    <div class="flex flex-1 overflow-hidden">
      <Sidebar :collapsed="sidebarCollapsed" />
      <ChatView v-if="currentPage === 'chat'" :current-session-id="currentSessionId" />
      <SettingsView
        v-else
        :api-key-missing="apiKeyMissing"
        @config-applied="onConfigApplied"
      />
    </div>
  </div>
</template>
