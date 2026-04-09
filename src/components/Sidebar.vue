<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../composables/useSession'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

const { sessions, currentSessionId, loadSessions, selectSession, createNewSession, deleteSession } = useSession()

onMounted(() => {
  loadSessions()
})
</script>

<template>
  <div class="flex h-full w-[250px] flex-col border-r bg-muted/30">
    <div class="px-4 py-3">
      <h1 class="text-lg font-semibold">xyz-agent</h1>
    </div>

    <Separator />

    <ScrollArea class="flex-1 px-2 py-2">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="group flex items-center gap-1 rounded-md px-2 py-1"
        :class="{ 'bg-accent': currentSessionId === session.id }"
      >
        <button
          class="flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
          @click="selectSession(session.id)"
        >
          {{ session.title }}
        </button>
        <button
          class="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="删除此会话"
          @click.stop="deleteSession(session.id)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>

      <div v-if="sessions.length === 0" class="px-2 py-8 text-center text-sm text-muted-foreground">
        暂无会话
      </div>
    </ScrollArea>

    <Separator />

    <div class="p-2">
      <Button class="w-full" @click="createNewSession">
        新建对话
      </Button>
    </div>
  </div>
</template>
