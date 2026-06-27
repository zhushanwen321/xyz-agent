<!--
  GitPanel —— SideDrawer git tab 内容（panel/spec.md：git 移入抽屉后唯一全量状态 UI）。

  原为 Panel 底部 zone ⑤（GitZone.vue，FR-12 常驻底部）。spec 统一为「git 进抽屉」后：
  - 入口（打开抽屉 git tab）+ 脏状态点 → PanelHeader 右侧 git 图标按钮
  - 全量状态（分支/pill/stats/文件列表/暂存/提交）→ 本组件（抽屉内 340px）

  数据来源：inject(GIT_STATUS_KEY)（Panel.vue 持有唯一实例）。PanelHeader 的脏状态点
  与本组件的 stage/unstage/commit 共享同一份数据——抽屉内 stage 后 header 点同步更新。
  非 git 仓库（isRepo=false）→ 整块不渲染（SideDrawer 此 tab 走空态）。

  commit 操作适配 340px 紧凑宽度：Input 独占一行，Stage/Unstage/Commit 一行（避免溢出）。
  commit message 用 xyz-ui Input（§6.3 点1，禁止原生 input）。
-->
<template>
  <!-- 冲突态 danger 左竖条（原 FR-12 item 2，draft-companion-zones §2） -->
  <section
    v-if="result?.isRepo"
    class="relative flex h-full flex-col gap-1.5 overflow-hidden p-2 text-[12px]"
    :class="result.hasConflict ? 'bg-danger/8' : ''"
  >
    <div
      v-if="result.hasConflict"
      class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-danger"
      aria-hidden="true"
    />
    <!-- 头部：分支 + 四态 pill + stats -->
    <div class="flex items-center gap-2">
      <GitBranch class="size-3 shrink-0 text-subtle" />
      <span class="truncate font-mono text-[11px] text-subtle">{{ result.branch ?? 'detached' }}</span>
      <span
        class="ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-medium"
        :class="pillClass"
      >{{ pillLabel }}</span>
      <span class="font-mono text-[10px]">
        <span class="text-success">+{{ result.stats.add }}</span>
        <span class="text-danger">−{{ result.stats.del }}</span>
      </span>
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:text-fg"
        :disabled="pending"
        title="刷新"
        @click="refresh"
      >
        <RefreshCw class="size-3" :class="pending ? 'animate-spin' : ''" />
      </Button>
    </div>

    <!-- 错误提示（操作失败 inline 回显） -->
    <p v-if="error" class="rounded-sm bg-danger/12 px-2 py-1 text-[11px] text-danger">{{ error }}</p>

    <!-- 文件列表 -->
    <ul v-if="result.files.length" class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      <li
        v-for="f in result.files"
        :key="f.path"
        class="flex items-center gap-2"
      >
        <span
          class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold"
          :class="statusBadgeClass(f.status)"
        >{{ statusBadge(f.status) }}</span>
        <span class="min-w-0 flex-1 truncate text-subtle" :title="f.path">{{ f.path }}</span>
      </li>
    </ul>

    <!-- 操作区（适配 340px 紧凑宽度：Input 独占一行，按钮一行） -->
    <div class="flex flex-col gap-1.5">
      <Input
        v-model="commitMsg"
        class="h-7 text-[11px]"
        placeholder="commit message"
        :disabled="pending"
        @keydown.enter="onCommit"
      />
      <div class="flex items-center gap-1.5">
        <Button
          variant="ghost"
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="pending || result.unstagedCount === 0"
          title="暂存全部改动"
          @click="stageAll"
        >Stage</Button>
        <Button
          variant="ghost"
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="pending || result.stagedCount === 0"
          title="取消全部暂存"
          @click="unstageAll"
        >Unstage</Button>
        <Button
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="!canCommit"
          :title="result.hasConflict ? '存在冲突，解决后才能提交' : '提交暂存区'"
          @click="onCommit"
        >Commit</Button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GitBranch, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useGitStatusOrFail, type GitState } from '@/composables/features/useGitStatus'
import type { GitFileStatus } from '@xyz-agent/shared'

/** 注入 Panel 提供的唯一 git 状态实例（缺失即装配错误） */
const {
  result,
  state,
  pending,
  error,
  commitMsg,
  canCommit,
  refresh,
  stageAll,
  unstageAll,
  commit,
} = useGitStatusOrFail()

const pillLabel = computed(
  () => ({ clean: 'Clean', staged: 'Staged', dirty: 'Dirty', conflict: 'Conflict' })[state.value],
)
const pillClass = computed(
  () =>
    (
      {
        clean: 'bg-success/12 text-success',
        staged: 'bg-success/12 text-success',
        dirty: 'bg-warning/14 text-warning',
        conflict: 'bg-danger/14 text-danger',
      } satisfies Record<GitState, string>
    )[state.value],
)

function onCommit(): void {
  void commit()
}

function statusBadge(status: GitFileStatus['status']): string {
  return ({ added: 'A', modified: 'M', deleted: 'D', unmerged: 'U', renamed: 'R', untracked: '?' })[status]
}

function statusBadgeClass(status: GitFileStatus['status']): string {
  return (
    {
      added: 'text-success',
      modified: 'text-warning',
      deleted: 'text-danger',
      unmerged: 'text-danger font-bold',
      renamed: 'text-accent',
      untracked: 'text-subtle',
    } satisfies Record<GitFileStatus['status'], string>
  )[status]
}
</script>
