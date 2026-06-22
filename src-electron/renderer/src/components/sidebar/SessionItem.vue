<template>
  <!--
    展示组件 · 单会话项（draft-five-states §1）。
    flex [dot] [main] [time]；active = surface-2 背景（Card-Active，design-system §2）+ inset accent-ring。
    hover 操作（重命名/删除）属 DEFERRED（G2-005/G-013），按 hide 规则不渲染入口。
    状态点 5 态（D6）：running/waiting 脉冲，done/stopped/error 静态。
  -->
  <div
    class="session-item group relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-[7px] transition-colors"
    :class="active ? 'bg-surface-2 ring-1 ring-inset ring-accent-ring' : 'hover:bg-surface-hover'"
    @click="emit('select', session.id)"
  >
    <span class="size-2 mt-1 shrink-0 rounded-full" :class="dotClass" />
    <div class="min-w-0 flex-1">
      <div
        class="truncate text-[12.5px] leading-[1.35]"
        :class="active ? 'text-accent' : 'text-fg'"
      >
        {{ session.label }}
      </div>
      <div class="mt-0.5 truncate font-mono text-[10.5px] leading-[1.3] text-subtle">
        {{ dirName }}
      </div>
      <div v-if="session.gitBranch" class="mt-0.5 truncate font-mono text-[10.5px] leading-[1.3] text-accent">
        {{ session.gitBranch }}
      </div>
    </div>
    <span class="shrink-0 pt-1 font-mono text-[10px] leading-[1.35] text-subtle group-hover:invisible">
      {{ timeLabel }}
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态点 class 映射（D6 五态，design-tokens SSOT 语义色）。
 * running/waiting 用同心环 pulse 动画（与 SessionCard 对齐）；
 * done/stopped/error 静态色。
 */
const props = defineProps<{
  session: {
    id: string
    label: string
    cwd: string
    gitBranch?: string
    lastActiveAt: number
  }
  active: boolean
  status: DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
}>()

/** 状态点语义类：背景色 + 脉冲动画。keyframes 收敛到 tailwind.config（与 SessionCard 共享 SSOT） */
const DOT_CLASS: Record<DerivedStatus, string> = {
  running: 'bg-accent animate-pulse-accent',
  waiting: 'bg-warning animate-pulse-warn',
  done: 'bg-success',
  stopped: 'bg-subtle opacity-50',
  error: 'bg-danger',
}
const dotClass = computed(() => DOT_CLASS[props.status])

/** 工作目录名（cwd 末段），长路径只显末段防溢出 */
const dirName = computed(() => props.session.cwd.split('/').filter(Boolean).pop() ?? props.session.cwd)

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

import { computed } from 'vue'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
</script>

