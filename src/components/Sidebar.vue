<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../composables/useSession'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

const { sessions, currentSessionId, loadSessions, selectSession, createNewSession } = useSession()

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
      <Button
        v-for="session in sessions"
        :key="session.id"
        variant="ghost"
        class="mb-1 w-full justify-start text-left"
        :class="{ 'bg-accent': currentSessionId === session.id }"
        @click="selectSession(session.id)"
      >
        <span class="truncate">{{ session.title }}</span>
      </Button>
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
