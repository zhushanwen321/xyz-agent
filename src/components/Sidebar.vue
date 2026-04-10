<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../composables/useSession'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

defineProps<{
  collapsed: boolean
}>()

const appName = __APP_NAME__
const { sessions, currentSessionId, loadSessions, selectSession, createNewSession, deleteSession } = useSession()

onMounted(() => {
  loadSessions()
})
</script>

<template>
  <div
    class="flex h-full shrink-0 flex-col border-r border-border-default bg-bg-elevated transition-all duration-200"
    :class="collapsed ? 'w-0 overflow-hidden border-r-0' : 'w-[240px]'"
  >

    <!-- 新建按钮 -->
    <div class="px-3 py-2">
      <button
        class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs text-accent transition-colors hover:bg-accent-muted"
        @click="createNewSession"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        NEW SESSION
      </button>
    </div>

    <Separator class="bg-border-default" />

    <!-- 会话列表 -->
    <div class="px-3 pt-2 pb-1">
      <span class="font-mono text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
        Sessions ({{ sessions.length }})
      </span>
    </div>

    <ScrollArea class="flex-1 px-2">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="group relative flex items-center rounded-md transition-colors"
        :class="currentSessionId === session.id
          ? 'bg-bg-inset text-text-primary'
          : 'text-text-secondary hover:bg-bg-inset/50 hover:text-text-primary'"
      >
        <!-- 左边框指示器 -->
        <div
          v-if="currentSessionId === session.id"
          class="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent"
        />
        <button
          class="flex-1 truncate px-3 py-2 text-left text-sm"
          @click="selectSession(session.id)"
        >
          {{ session.title }}
        </button>
        <button
          class="mr-1 shrink-0 rounded p-1 text-text-tertiary opacity-0 transition-all hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100"
          title="删除此会话"
          @click.stop="deleteSession(session.id)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>

      <div v-if="sessions.length === 0" class="px-3 py-8 text-center font-mono text-xs text-text-tertiary">
        No sessions
      </div>
    </ScrollArea>

    <Separator class="bg-border-default" />

    <!-- 底部区域 -->
    <div class="px-4 py-3">
      <div class="font-mono text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
        Active Context
      </div>
      <div class="mt-1.5 space-y-0.5 font-mono text-[11px]">
        <div class="text-text-tertiary">PRJ: <span class="text-accent">{{ appName }}</span></div>
      </div>
    </div>
  </div>
</template>
