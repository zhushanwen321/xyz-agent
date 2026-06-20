<template>
  <!--
    展示组件 · 会话列表（子视图 A，draft-five-states 卡 A/D）。
    ScrollArea 包裹会话项列表；空态（D，session 数=0）显示极淡「暂无会话」占位。
    v-model 语义用 activeId（单向：子→父 select）。
  -->
  <ScrollArea class="session-list h-full">
    <div class="flex flex-col gap-0.5 px-1">
      <SessionItem
        v-for="s in sessions"
        :key="s.id"
        :session="s"
        :active="s.id === activeId"
        :status="statusOf(s.id)"
        @select="emit('select', $event)"
      />
    </div>
    <div
      v-if="sessions.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center"
    >
      <p class="text-[11.5px] text-subtle opacity-55">暂无会话</p>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 rounded-md px-2 text-[11.5px] text-muted hover:bg-surface-hover hover:text-fg"
        @click="emit('newSession')"
      >
        <Plus class="size-[14px]" />
        新建会话
      </Button>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import type { SessionSummary } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'
import { Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import SessionItem from './SessionItem.vue'

const props = defineProps<{
  sessions: SessionSummary[]
  activeId: string | null
  /** 派生状态点（D6），由容器注入 useSidebar.derivedStatus */
  statusOf: (id: string) => DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  newSession: []
}>()

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
