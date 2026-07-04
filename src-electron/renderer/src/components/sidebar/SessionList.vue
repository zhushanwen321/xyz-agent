<template>
  <!--
    展示组件 · 会话列表（子视图 A，draft-five-states 卡 A/D）。
    按 cwd 分组渲染（D7：对齐后端 SessionGroup[]）—— 每组一个标题（cwd 末段）+ 组内 SessionItem 列表。
    ScrollArea 包裹；空态（D，session 数=0）显示极淡「暂无会话」占位。
    v-model 语义用 activeId（单向：子→父 select）。
  -->
  <ScrollArea class="session-list h-full">
    <div class="flex flex-col px-1">
      <div
        v-for="g in groups"
        :key="g.cwd"
        class="group-section flex flex-col gap-0.5"
      >
        <!-- 组标题：cwd 末段（长路径只显末段防溢出，与 SessionItem.dirName 同一信息原子） -->
        <div class="sticky top-0 z-[1] flex items-center gap-1.5 bg-surface/95 px-2 pb-0.5 pt-2 backdrop-blur-sm">
          <Folder class="size-[11px] shrink-0 text-subtle" />
          <span class="truncate text-[10.5px] font-medium uppercase tracking-wide text-subtle">
            {{ dirNameOf(g.cwd) }}
          </span>
          <span class="font-mono text-[9.5px] text-subtle opacity-60">{{ g.sessions.length }}</span>
        </div>
        <SessionItem
          v-for="s in g.sessions"
          :key="s.id"
          :session="s"
          :active="s.id === activeId"
          :status="statusOf(s.id)"
          @select="emit('select', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
        />
      </div>
    </div>
    <div
      v-if="totalCount === 0"
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
import type { SessionGroup } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'
import { computed } from 'vue'
import { Plus, Folder } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { dirNameOf } from '@/composables/logic/path'
import SessionItem from './SessionItem.vue'

const props = defineProps<{
  /** 按 cwd 分组的会话（D7，对齐后端 SessionGroup[]） */
  groups: SessionGroup[]
  activeId: string | null
  /** 派生状态点（D6），由容器注入 useSessionDerivations.derivedStatus */
  statusOf: (id: string) => DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  newSession: []
}>()

/** 全部 session 总数（空态判定，跨组汇总） */
const totalCount = computed(() =>
  props.groups.reduce((sum, g) => sum + g.sessions.length, 0),
)

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
