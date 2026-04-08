<script setup lang="ts">
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import StatusBar from './components/StatusBar.vue'
import { useSession } from './composables/useSession'

const { currentSessionId } = useSession()
</script>

<template>
  <div class="flex h-screen flex-col bg-background text-foreground">
    <div class="flex flex-1 overflow-hidden">
      <Sidebar />
      <ChatView :current-session-id="currentSessionId" />
    </div>

    <StatusBar
      :is-streaming="false"
      model-name="claude-sonnet-4-5"
    />
  </div>
</template>
