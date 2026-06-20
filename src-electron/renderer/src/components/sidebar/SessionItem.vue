<template>
  <!--
    展示组件 · 单会话项（draft-five-states §1）。
    grid [dot] [main] [time]；active = accent-soft 背景 + 左侧 2px accent 竖条。
    hover 操作（重命名/删除）属 DEFERRED（G2-005/G-013），按 hide 规则不渲染入口。
    状态点 5 态（D6）：running/waiting 脉冲，done/stopped/error 静态。
  -->
  <div
    class="session-item group relative grid cursor-pointer items-start gap-2 rounded-md px-2 py-[7px] transition-colors"
    :class="active ? 'bg-accent-soft' : 'hover:bg-surface-hover'"
    @click="emit('select', session.id)"
  >
    <span v-if="active" class="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-sm bg-accent" />
    <span class="mt-1 h-2 w-2 shrink-0 rounded-full" :class="dotClass" />
    <div class="min-w-0">
      <div
        class="truncate text-[12.5px] leading-[1.35]"
        :class="active ? 'text-accent' : 'text-fg'"
      >
        {{ session.label }}
      </div>
      <div class="mt-0.5 truncate font-mono text-[10.5px] leading-[1.3] text-subtle">
        <span>{{ dirName }}</span>
        <span v-if="session.gitBranch" class="opacity-60"> · </span>
        <span v-if="session.gitBranch" class="text-accent">{{ session.gitBranch }}</span>
      </div>
    </div>
    <span class="shrink-0 pt-0.5 font-mono text-[10px] leading-[1.35] text-subtle group-hover:invisible">
      {{ timeLabel }}
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态点 class 映射（D6 五态，design-tokens SSOT 语义色）。
 * running/waiting 用 Tailwind animate-pulse 呼吸（spec §会话项：两态均带脉冲）；
 * done/stopped/error 静态色。无 scoped CSS，全 Tailwind 工具类。
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

const dotClass = computed(() => {
  const map: Record<DerivedStatus, string> = {
    running: 'bg-accent animate-pulse',
    waiting: 'bg-warning animate-pulse',
    done: 'bg-success',
    stopped: 'bg-subtle opacity-50',
    error: 'bg-danger',
  }
  return map[props.status]
})

/** 工作目录名（cwd 末段），长路径只显末段防溢出 */
const dirName = computed(() => props.session.cwd.split('/').filter(Boolean).pop() ?? props.session.cwd)

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

import { computed } from 'vue'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
</script>
