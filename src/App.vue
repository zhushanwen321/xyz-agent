<script setup lang="ts">
import { ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import Topbar from './components/Topbar.vue'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'
import { useSession } from './composables/useSession'

const { currentSessionId } = useSession()
const sidebarCollapsed = ref(false)
const currentPage = ref<'chat' | 'settings'>('chat')
</script>

<template>
  <div class="flex h-screen flex-col bg-bg-surface text-text-primary">
    <Topbar
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @navigate="(page) => { currentPage = page }"
    />

    <div class="flex flex-1 overflow-hidden">
      <Sidebar :collapsed="sidebarCollapsed" />
      <ChatView v-if="currentPage === 'chat'" :current-session-id="currentSessionId" />
      <SettingsView v-else />
    </div>
  </div>
</template>
