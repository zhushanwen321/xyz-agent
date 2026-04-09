<script setup lang="ts">
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import { useSession } from './composables/useSession'

const { currentSessionId } = useSession()
</script>

<template>
  <div class="flex h-screen bg-bg-surface text-text-primary">
    <Sidebar />
    <ChatView :current-session-id="currentSessionId" />
  </div>
</template>
