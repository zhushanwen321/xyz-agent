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
    <span class="status-dot" :class="dotClass" />
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
 * 状态点 class 映射（D6 五态）。
 * running/waiting 带 pulse 动画（@keyframes 在 scoped style，Tailwind 无对应工具类）。
 * done/stopped/error 静态语义色（design-tokens SSOT 色）。
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
  status: 'running' | 'waiting' | 'done' | 'stopped' | 'error'
}>()

const emit = defineEmits<{
  select: [sessionId: string]
}>()

const dotClass = computed(() => `status-dot--${props.status}`)

/** 工作目录名（cwd 末段），长路径只显末段防溢出 */
const dirName = computed(() => props.session.cwd.split('/').filter(Boolean).pop() ?? props.session.cwd)

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

import { computed } from 'vue'
import { formatRelativeTime } from '@/composables/logic/formatTime'
</script>

<style scoped>
/* 状态点：8px 圆点，5 态语义色。running/waiting 带 pulse（box-shadow 扩散，draft 同款）。
   色值走 CSS 变量（design-tokens SSOT），不硬编码。 */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}
.status-dot--running {
  background: var(--accent);
  animation: pulse-accent 2s var(--ease) infinite;
}
.status-dot--waiting {
  background: var(--warning);
  animation: pulse-warn 2s var(--ease) infinite;
}
.status-dot--done { background: var(--success); }
.status-dot--stopped { background: var(--subtle); opacity: 0.5; }
.status-dot--error { background: var(--danger); }

@keyframes pulse-accent {
  0% { box-shadow: 0 0 0 0 rgba(79, 142, 247, 0.5); }
  70% { box-shadow: 0 0 0 5px rgba(79, 142, 247, 0); }
  100% { box-shadow: 0 0 0 0 rgba(79, 142, 247, 0); }
}
@keyframes pulse-warn {
  0% { box-shadow: 0 0 0 0 rgba(245, 165, 36, 0.5); }
  70% { box-shadow: 0 0 0 5px rgba(245, 165, 36, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 165, 36, 0); }
}
</style>
