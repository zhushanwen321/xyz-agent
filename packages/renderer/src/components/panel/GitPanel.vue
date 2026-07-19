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
    :class="result.hasConflict ? 'bg-danger-soft' : ''"
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
        :title="t('panel.git.refresh')"
        @click="refresh"
      >
        <RefreshCw class="size-3" :class="pending ? 'animate-spin' : ''" />
      </Button>
    </div>

    <!-- 错误提示（操作失败 inline 回显） -->
    <p v-if="error" class="rounded-sm bg-danger-soft px-2 py-1 text-[11px] text-danger">{{ error }}</p>

    <!-- 文件列表（点击跳转 detail tab 查看 diff：selectFile 设 selectedPath + drawer 切 detail） -->
    <ul v-if="result.files.length" class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      <li
        v-for="f in result.files"
        :key="f.path"
        class="group/li flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-surface-2"
        :title="t('panel.git.viewDiff', { path: f.path })"
        @click="onFileClick(f.path)"
      >
        <span
          class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold"
          :class="statusBadgeClass(f.status)"
        >{{ statusBadge(f.status) }}</span>
        <span class="min-w-0 flex-1 truncate text-subtle">{{ f.path }}</span>
        <Button
          variant="ghost"
          data-testid="git-inject-file"
          class="size-5 shrink-0 rounded-sm p-0 opacity-0 transition-opacity hover:text-accent group-hover/li:opacity-100"
          :title="t('panel.detail.injectFileRef')"
          @click.stop="onInjectFileRef(f.path)"
        >
          <Quote class="size-3" />
        </Button>
      </li>
    </ul>

    <!-- 操作区（适配 340px 紧凑宽度：Input 独占一行，按钮一行） -->
    <div class="flex flex-col gap-1.5">
      <Input
        v-model="commitMsg"
        class="h-7 text-[11px]"
          :placeholder="t('panel.git.commitPlaceholder')"
        :disabled="pending"
        @keydown.enter="onCommit"
      />
      <div class="flex items-center gap-1.5">
        <Button
          variant="ghost"
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="pending || result.unstagedCount === 0"
          :title="t('panel.git.stageAll')"
          @click="stageAll"
        >{{ t('panel.git.stage') }}</Button>
        <Button
          variant="ghost"
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="pending || result.stagedCount === 0"
          :title="t('panel.git.unstageAll')"
          @click="unstageAll"
        >{{ t('panel.git.unstage') }}</Button>
        <Button
          class="h-7 flex-1 shrink-0 rounded-sm px-2 text-[11px]"
          :disabled="!canCommit"
          :title="result.hasConflict ? t('panel.git.conflictBlock') : t('panel.git.commitStaged')"
          @click="onCommit"
        >{{ t('panel.git.commit') }}</Button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitBranch, RefreshCw, Quote } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useGitStatusOrFail, type GitState } from '@/composables/features/useGitStatus'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import type { GitFileStatus } from '@xyz-agent/shared'

const { t } = useI18n()

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

const fileTreeStore = useFileTreeStore()
const drawer = useSideDrawer()
const sessionStore = useSessionStore()
const composerInjection = useComposerInjectionStore()

/**
 * FR-6: 注入文件引用到 composer（无行范围，target=current）。
 * GitPanel 无 sessionId prop（git 状态全局），取活跃 session id 作为注入目标。
 * @click.stop 阻止冒泡到 li 的 onFileClick（跳 detail），使注入与跳转互不干扰。
 */
function onInjectFileRef(path: string): void {
  composerInjection.requestInjection({
    target: 'current',
    path,
    sessionId: sessionStore.active?.id ?? null,
  })
}

/**
 * 点击文件项 → 跳 detail tab 查看 diff（复刻 FileTreeRow.onSelectFile 模式）。
 * - selectFile 设 store.selectedPath（useDetailPane watch 自动加载内容）
 * - drawer.open('detail') 打开抽屉切 detail tab
 *
 * 数据一致性：result.files 与 fileTreeStore.gitOverlay 均来自 git.status RPC（同源），
 * 故 DetailPane 的 getGitStatus(sid, path) 能命中该文件记录 → viewMode='diff'。
 * 边界：session 文件树未加载时 gitOverlay 为空，此时 DetailPane 会走 preview 模式（无 diff），
 * 属可接受的降级（正常流程文件树已加载）。
 */
function onFileClick(path: string): void {
  fileTreeStore.selectFile(path)
  drawer.open('detail')
}

const pillLabel = computed(
  () => {
    const map: Record<GitState, string> = {
      clean: t('panel.git.pillClean'),
      staged: t('panel.git.pillStaged'),
      dirty: t('panel.git.pillDirty'),
      conflict: t('panel.git.pillConflict'),
    }
    return map[state.value as GitState]
  },
)
const pillClass = computed(
  () =>
    (
      {
        clean: 'bg-success-soft text-success',
        staged: 'bg-success-soft text-success',
        dirty: 'bg-warning-soft text-warning',
        conflict: 'bg-danger-soft text-danger',
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
