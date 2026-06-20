<template>
  <!--
    展示组件 · panel-header（panel/spec.md zone ①，draft-dual-panel header 结构）。
    布局：状态点 + session名 + 目录 + ... + [split|新建会话] + 更多 + 关闭。
    状态点 per-session；目录 mono 可点；split/新建会话同槽位互斥（单显 split，双显新建会话）。
    split 单 session 场景（G-023）/ close 确认流（G-013）DEFERRED：v1 渲染按钮但 split 触发结构切换，
    close 双→单可用；更多菜单（G2-005 rename 等）DEFERRED hide。
  -->
  <header class="flex h-[38px] flex-shrink-0 items-center gap-2 border-b border-border px-3.5 pl-4">
    <span class="status-dot" :class="`status-dot--${status}`" />
    <span class="text-[12.5px] font-semibold" :class="active ? 'text-fg' : 'text-muted'">
      {{ sessionLabel }}
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="group h-auto max-w-[240px] gap-1.5 rounded-sm border border-transparent px-1.5 py-1 font-mono text-[11px] text-subtle hover:bg-surface-hover hover:text-muted"
      :title="`工作目录：${sessionDir}`"
    >
      <Folder class="size-3 shrink-0 opacity-85" />
      <span class="truncate">{{ dirName }}</span>
    </Button>

    <div class="ml-auto flex items-center gap-0.5">
      <!-- split：单 panel 显（开第二会话）；双 panel 时隐藏（不允许多于 2） -->
      <Button
        v-if="!isDual"
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg"
        title="分屏 · 开第二会话"
        @click="emit('split')"
      >
        <Columns2 class="size-[15px]" />
      </Button>
      <!-- 关闭（×）：双 panel → 关闭该侧回单。单 panel 关闭主会话确认流 G-013 DEFERRED，v1 不显 -->
      <Button
        v-if="isDual"
        variant="ghost"
        size="icon"
        class="close-btn size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg"
        title="关闭会话"
        @click="emit('close')"
      >
        <X class="size-[15px]" />
      </Button>
    </div>
  </header>
</template>

<script setup lang="ts">
/* eslint-disable no-magic-numbers */
import { computed } from 'vue'
import { Folder, Columns2, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'

const props = defineProps<{
  sessionLabel: string
  sessionDir: string
  status: DerivedStatus
  active: boolean
  isDual: boolean
}>()

const emit = defineEmits<{
  split: []
  close: []
}>()

/** 工作目录名（cwd 末段），长路径只显末段防溢出 */
const dirName = computed(() => {
  const segs = props.sessionDir.split('/').filter(Boolean)
  return segs.length > 1 ? `${segs[segs.length - 2]}/${segs[segs.length - 1]}` : (segs[0] ?? props.sessionDir)
})
</script>

<style scoped>
/* 状态点：7px 圆点，per-session 状态色（与 sidebar 5 态一致，design-tokens SSOT）。 */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--running {
  background: var(--accent);
  animation: pulse 1.8s var(--ease) infinite;
}
.status-dot--waiting { background: var(--warning); }
.status-dot--done { background: var(--success); }
.status-dot--stopped { background: var(--subtle); opacity: 0.5; }
.status-dot--error { background: var(--danger); }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--accent-soft); }
  50% { box-shadow: 0 0 0 6px rgba(79, 142, 247, 0.06); }
}
/* close hover 变红（关闭语义，draft-dual-panel ph-close） */
.close-btn:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.12);
}
</style>
