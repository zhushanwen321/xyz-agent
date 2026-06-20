<template>
  <!--
    展示组件 · panel-header（panel/spec.md zone ①，draft-dual-panel header 结构）。
    布局：状态点 + breadcrumb（项目▸会话▸分支，shell/spec §四）+ ... + [split|新建会话] + 更多 + 关闭。
    breadcrumb 三段：项目名（cwd 末段）▸ 会话名 ▸ 分支名（mono+accent）。
    popover 点击跳转 DEFERRED（shell/spec §八，属 G3 联调）；v1 纯展示。
    状态点 per-session；split/新建会话同槽位互斥（单显 split，双显新建会话）。
    split 单 session 场景（G-023）/ close 确认流（G-013）DEFERRED：v1 渲染按钮但 split 触发结构切换，
    close 双→单可用；更多菜单（G2-005 rename 等）DEFERRED hide。
    拖拽区（shell/spec §七-6）：header 空白 -webkit-app-region:drag，交互元素 no-drag。
  -->
  <header
    class="flex h-[38px] flex-shrink-0 items-center gap-2 border-b border-border px-3.5 pl-4 [-webkit-app-region:drag]"
  >
    <span
      class="size-[7px] shrink-0 rounded-full"
      :class="statusDotClass"
    />
    <!-- breadcrumb（shell/spec §四：项目 ▸ 会话 ▸ 分支，落点在 main-header 内） -->
    <nav class="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <ol class="flex min-w-0 items-center gap-1 text-[12.5px]">
        <li class="flex min-w-0 items-center gap-1.5">
          <Folder class="size-3 shrink-0 opacity-70 text-subtle" />
          <span
            class="truncate font-mono text-[11px] text-subtle"
            :title="`工作目录：${sessionDir}`"
          >{{ dirName }}</span>
        </li>
        <li aria-hidden="true" class="text-subtle opacity-50">
          <ChevronRight class="size-3 shrink-0" />
        </li>
        <li class="min-w-0">
          <span
            class="truncate font-semibold"
            :class="active ? 'text-fg' : 'text-muted'"
          >{{ sessionLabel }}</span>
        </li>
        <template v-if="gitBranch">
          <li aria-hidden="true" class="text-subtle opacity-50">
            <ChevronRight class="size-3 shrink-0" />
          </li>
          <li class="min-w-0">
            <span
              class="truncate font-mono text-[11px] text-accent"
              :title="`分支：${gitBranch}`"
            >{{ gitBranch }}</span>
          </li>
        </template>
      </ol>
    </nav>

    <div class="ml-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <!-- split：单 panel 显（开第二会话）；双 panel 时隐藏（不允许多于 2） -->
      <Button
        v-if="!isDual"
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
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
        class="size-[26px] rounded-md text-muted hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [-webkit-app-region:no-drag]"
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
import { Folder, Columns2, X, ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'

const props = defineProps<{
  sessionLabel: string
  sessionDir: string
  gitBranch?: string
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

/** 状态点 5 态色（design-tokens SSOT，与 sidebar 一致）。running 用 animate-pulse 呼吸。 */
const statusDotClass = computed(() => {
  const map: Record<DerivedStatus, string> = {
    running: 'bg-accent animate-pulse',
    waiting: 'bg-warning',
    done: 'bg-success',
    stopped: 'bg-subtle opacity-50',
    error: 'bg-danger',
  }
  return map[props.status]
})
</script>
