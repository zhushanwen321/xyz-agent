<template>
  <!--
    展示组件 · git-zone（panel/spec.md zone ⑤，composer 下方单行）。
    左：分支名 + 变更统计；右：暂存/提交/Diff 操作按钮。
    FG4 骨架：分支名 + 「工作区干净/改动」占位态。git 操作（暂存/提交/Diff）走 Side Drawer
    （diff 抽屉）属 G-023/G detail-pane，DEFERRED：v1 渲染分支名 + Diff 按钮（hide 暂存/提交，待联调）。
    无 gitBranch 时隐藏（session 无 git）。
  -->
  <div
    v-if="gitBranch"
    class="mx-3.5 mb-3 flex h-[38px] flex-shrink-0 items-center gap-2.5 rounded-lg border border-border bg-bg-input px-3"
  >
    <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent">
      <GitBranch class="size-[13px]" />
      {{ gitBranch }}
    </span>
    <span class="h-4 w-px bg-border" />
    <span class="font-mono text-[11px] text-subtle">工作区干净</span>
    <div class="ml-auto flex gap-1">
      <Button
        variant="ghost"
        size="sm"
        class="h-auto rounded-sm border border-border-strong bg-transparent py-1 font-mono text-[11px] text-muted hover:bg-surface-hover hover:text-fg"
        title="Diff（Side Drawer 待联调）"
        @click="emit('diff')"
      >
        Diff
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { GitBranch } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{
  gitBranch?: string
}>()

const emit = defineEmits<{
  diff: []
}>()
</script>
