<script setup lang="ts">
/**
 * BranchSelectPopover.vue —— 步骤3 Git popover（分支/Worktree 双 tab，spec §3.3 IA 重构）。
 *
 * 语义升级：从「选分支 popover」升级为「Git popover（分支/Worktree 双 tab）」。
 * Tab 栏在搜索框上方，分支 tab 承载原有全部分支逻辑，Worktree tab 承载 worktree 列表。
 * 文件名保留 BranchSelectPopover（语义升级，不重命名，避免大面积引用改动）。
 *
 * 形态：popover 内容面板（宽度 420px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data，分支 tab）：onMounted → gitApi.status(sessionId) → GitStatusResult。
 * - unborn HEAD（T4.3 / AC-6.3）：isRepo=true 且 branches=[] → 空态引导首次 commit
 * - getStatus 失败（T4.6 / AC-6.4）：reject → 显错不崩
 * - 分支 100+（T4.9 / AC-6.9）：渲染上限 + 搜索过滤
 *
 * 数据流（Worktree tab）：worktreeItems 由父级注入。
 * 守卫说明：本组件在 git 仓库下打开（调用方 Landing 的 Git chip 用 `v-if="branch"` 守卫，
 * 非 git 目录不显 chip → 本组件不会被打开），故 Worktree tab 无需额外 isGitRepo 守卫。
 *
 * 动作（presentational for actions，emit 单 payload 对象）：
 * 分支 tab：
 * - 选干净分支 → emit('select', { name })（父接 useNewTaskFlow.selectBranch）
 * - dirty 工作区选其它分支 → inline 二次确认条 → 确认 emit('confirm-dirty-switch', { name })
 *   （父接 useNewTaskFlow.confirmDirtySwitch，v1「留在工作区」不 stash，spec §3.3）
 * - 「创建并检出新分支」→ emit('open-branch-modal')（父接 useNewTaskFlow.openBranchModal）
 * - 「Git 图谱」→ v1 stub toast（spec §6 / issues #12 P3 延后）
 * Worktree tab：
 * - 选 worktree → emit('select-worktree', { path })（父接 useNewTaskFlow.selectWorktree）
 * - 「新建 worktree」→ emit('create-worktree')（父接 useNewTaskFlow.createWorktree）
 * - Esc → emit('close')
 */
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitBranch, GitFork, Plus, GitGraph, TriangleAlert } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { PopoverListItem, PopoverActionItem } from '@/components/ui/popover'
import { git as gitApi } from '@/api'
import { useToast } from '@/composables/useToast'
import { useFlatListNav } from '@/composables/logic/useFlatListNav'
import type { GitStatusResult } from '@xyz-agent/shared'

/** T4.9 / AC-6.9：分支极多时渲染上限，超出靠搜索过滤（v1 限制渲染数，不引入虚拟滚动库） */
const MAX_RENDER_BRANCHES = 50
/** 分支 tab 尾部动作项数（创建并检出新分支 + Git 图谱） */
const BRANCH_ACTION_COUNT = 2
/** Worktree tab 尾部动作项数（新建 worktree） */
const WORKTREE_ACTION_COUNT = 1
/** spec §6：Git 图谱 v1 stub（issues #12 P3） */
// v1 暂未支持 Git 图谱（i18n key: newTask.branchSelect.gitNotSupported）

const props = withDefaults(
  defineProps<{
    /** 当前 session id（拉取 git status 用） */
    sessionId: string | null
    /** 当前 cwd 所在 workspace 的已有 worktree 列表（Worktree tab 数据源） */
    worktreeItems?: Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }>
  }>(),
  { worktreeItems: () => [] },
)

const emit = defineEmits<{
  (e: 'select', payload: { name: string }): void
  (e: 'confirm-dirty-switch', payload: { name: string }): void
  (e: 'open-branch-modal'): void
  (e: 'select-worktree', payload: { path: string }): void
  (e: 'create-worktree'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const { error: toastError } = useToast()

const status = ref<GitStatusResult | null>(null)
const statusError = ref<unknown>(null)
const search = ref('')
const root = ref<HTMLElement | null>(null)
/** dirty 二次确认条待确认的目标分支名（null = 无确认条） */
const pendingDirtyBranch = ref<string | null>(null)
/** 当前激活 tab（分支 / Worktree） */
const activeTab = ref<'branch' | 'worktree'>('branch')

onMounted(async () => {
  if (!props.sessionId) return
  // 打开即 focus 搜索框（spec §3.3 键盘契约）
  nextTick(() => root.value?.querySelector('input')?.focus())
  try {
    status.value = await gitApi.status(props.sessionId)
  } catch (e) {
    // T4.6 / AC-6.4：显错不崩
    statusError.value = e
  }
})

const allBranches = computed<string[]>(() => status.value?.branches ?? [])
const currentBranch = computed<string | undefined>(() => status.value?.branch)
/** 当前工作区未提交文件数（dirty 判据，AC-6.2） */
const dirtyCount = computed(
  () => (status.value?.stagedCount ?? 0) + (status.value?.unstagedCount ?? 0),
)
const isDirty = computed(() => dirtyCount.value > 0)

/** unborn HEAD（T4.3）：是 git 仓库但无任何分支（无首次提交） */
const isUnborn = computed(
  () => status.value?.isRepo === true && allBranches.value.length === 0,
)

/** 搜索过滤 + 渲染上限（T4.9） */
const filtered = computed<string[]>(() => {
  const q = search.value.trim().toLowerCase()
  const list = q
    ? allBranches.value.filter((b) => b.toLowerCase().includes(q))
    : allBranches.value
  return list.slice(0, MAX_RENDER_BRANCHES)
})

function selectBranch(name: string): void {
  if (name === currentBranch.value) {
    emit('close') // 已在当前分支，仅关 popover
    return
  }
  // dirty 工作区切走 → inline 二次确认条（spec §3.3，不弹 modal）
  if (isDirty.value) {
    pendingDirtyBranch.value = name
    return
  }
  emit('select', { name })
}

function confirmDirtySwitch(): void {
  const name = pendingDirtyBranch.value
  pendingDirtyBranch.value = null
  if (name) emit('confirm-dirty-switch', { name })
}

function cancelDirty(): void {
  pendingDirtyBranch.value = null
}

function openBranchModal(): void {
  emit('open-branch-modal')
}

function gitGraphStub(): void {
  toastError(t('newTask.branchSelect.gitNotSupported'))
}

function selectWorktree(path: string): void {
  emit('select-worktree', { path })
}

function createWorktree(): void {
  emit('create-worktree')
}

/**
 * 扁平化激活（按 activeTab 路由）：
 * - 分支 tab：idx < branchesLen → selectBranch；尾部动作项顺序（创建分支 / Git 图谱）
 * - Worktree tab：idx < wtLen → selectWorktree(worktreeItems[idx].path)；idx === wtLen → createWorktree()
 */
function activate(idx: number): void {
  if (activeTab.value === 'worktree') {
    const wtLen = props.worktreeItems.length
    if (idx < wtLen) selectWorktree(props.worktreeItems[idx].path)
    else if (idx === wtLen) createWorktree()
    return
  }
  const listLen = filtered.value.length
  if (idx < listLen) selectBranch(filtered.value[idx])
  else if (idx === listLen) openBranchModal()
  else gitGraphStub()
}

// 键盘导航收敛到 logic/useFlatListNav（与 DirSelectPopover 共用）。
const { activeIndex, onKeydown, isActiveItem } = useFlatListNav({
  getTotal: () =>
    activeTab.value === 'worktree'
      ? props.worktreeItems.length + WORKTREE_ACTION_COUNT
      : filtered.value.length + BRANCH_ACTION_COUNT,
  onActivate: activate,
  onEscape: () => emit('close'),
})

// 切 tab 时重置 activeIndex 为 0，保证新 tab 第一个列表项预高亮。
watch(activeTab, () => {
  activeIndex.value = 0
})
</script>

<template>
  <div
    ref="root"
    data-testid="branch-select-popover"
    class="w-[420px] overflow-hidden rounded-md border border-border-strong bg-bg-elevated shadow-2 outline-none"
    @keydown="onKeydown"
  >
    <!-- Tab 栏（搜索框上方）：分支 / Worktree -->
    <div class="flex gap-0 border-b border-border px-1">
      <Button
        variant="ghost"
        data-testid="git-tab-branch"
        :class="[
          'relative h-auto items-center gap-1.5 rounded-none px-3.5 py-2.5 text-[12px] font-medium transition-colors',
          activeTab === 'branch'
            ? 'text-fg after:absolute after:left-1 after:right-1 after:bottom-[-1px] after:h-0.5 after:rounded-t-sm after:bg-accent'
            : 'text-subtle hover:text-muted',
        ]"
        @click="activeTab = 'branch'"
      >
        <GitBranch
          :class="['size-[13px]', activeTab === 'branch' ? 'opacity-100' : 'opacity-80']"
        />
        <span>{{ t('newTask.branchSelect.branchLabel') }}</span>
        <span
          :class="[
            'min-w-4 rounded-md px-1.25 py-0.5 text-center text-[10px] font-semibold',
            activeTab === 'branch'
              ? 'bg-accent-soft text-accent'
              : 'bg-surface-hover text-subtle',
          ]"
        >{{ allBranches.length }}</span>
      </Button>
      <Button
        variant="ghost"
        data-testid="git-tab-worktree"
        :class="[
          'relative h-auto items-center gap-1.5 rounded-none px-3.5 py-2.5 text-[12px] font-medium transition-colors',
          activeTab === 'worktree'
            ? 'text-fg after:absolute after:left-1 after:right-1 after:bottom-[-1px] after:h-0.5 after:rounded-t-sm after:bg-accent'
            : 'text-subtle hover:text-muted',
        ]"
        @click="activeTab = 'worktree'"
      >
        <GitFork
          :class="['size-[13px]', activeTab === 'worktree' ? 'opacity-100' : 'opacity-80']"
        />
        <span>{{ t('newTask.dirSelect.existingWorktrees') }}</span>
        <span
          :class="[
            'min-w-4 rounded-md px-1.25 py-0.5 text-center text-[10px] font-semibold',
            activeTab === 'worktree'
              ? 'bg-accent-soft text-accent'
              : 'bg-surface-hover text-subtle',
          ]"
        >{{ props.worktreeItems.length }}</span>
      </Button>
    </div>

    <!-- ───── 分支 panel ───── -->
    <div v-show="activeTab === 'branch'">
      <!-- 搜索 input -->
      <div class="border-b border-border p-2">
        <Input
          v-model="search"
          :placeholder="t('newTask.branchSelect.searchPlaceholder')"
          class="h-8 bg-surface-2 text-[13px]"
        />
      </div>

      <!-- getStatus 失败（T4.6） -->
      <div
        v-if="statusError"
        data-testid="status-error"
        class="flex items-center gap-2 px-3 py-4 text-[12px] text-danger"
      >
        <TriangleAlert class="size-4 shrink-0" />
        <span>{{ t('newTask.branchSelect.loadFailed') }}</span>
      </div>

      <!-- unborn HEAD 空态（T4.3） -->
      <div
        v-else-if="isUnborn"
        data-testid="empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <GitBranch class="size-5 text-subtle" />
        <p class="text-[12px] text-muted">{{ t('newTask.branchSelect.noBranch') }}</p>
      </div>

      <!-- 分支列表 -->
      <div v-else class="py-1">
        <div class="flex items-center justify-between px-3 py-1 text-[11px] text-subtle">
          <span>{{ t('newTask.branchSelect.branchLabel') }}</span>
          <span>{{ allBranches.length }}</span>
        </div>

        <PopoverListItem
          v-for="(name, i) in filtered"
          :key="name"
          test-id="branch-item"
          :active="isActiveItem(i)"
          :selected="name === currentBranch"
          @click="selectBranch(name)"
          @mouseenter="activeIndex = i"
        >
          <template #icon>
            <GitBranch class="shrink-0 text-subtle" />
          </template>
          <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span class="truncate font-mono text-fg">{{ name }}</span>
            <!-- 当前分支 dirty subline（spec §3.3 warning dot + mono 小字） -->
            <span
              v-if="name === currentBranch && isDirty"
              class="flex items-center gap-1 text-[11px] text-warning"
            >
              <span class="size-1.5 shrink-0 rounded-full bg-warning" />
              {{ t('newTask.branchSelect.dirtyChanges', { count: dirtyCount }) }}
            </span>
          </span>
        </PopoverListItem>

        <div class="my-1 h-px bg-border" />

        <!-- 动作项：创建并检出新分支 -->
        <PopoverActionItem
          test-id="action-create-branch"
          :active="isActiveItem(filtered.length)"
          @click="openBranchModal"
          @mouseenter="activeIndex = filtered.length"
        >
          <template #icon>
            <Plus class="shrink-0 text-subtle" />
          </template>
          {{ t('newTask.branchSelect.createAndCheckout') }}
        </PopoverActionItem>

        <!-- 动作项：Git 图谱（v1 stub） -->
        <PopoverActionItem
          test-id="action-git-graph"
          :active="isActiveItem(filtered.length + 1)"
          @click="gitGraphStub"
          @mouseenter="activeIndex = filtered.length + 1"
        >
          <template #icon>
            <GitGraph class="shrink-0 text-subtle" />
          </template>
          {{ t('newTask.branchSelect.gitGraph') }}
        </PopoverActionItem>
      </div>

      <!-- dirty inline 二次确认条（spec §3.3，非 modal） -->
      <div
        v-if="pendingDirtyBranch"
        data-testid="dirty-confirm"
        class="flex flex-col gap-2 border-t border-warning/40 bg-warning-soft px-3 py-2.5 text-[12px] text-fg"
      >
        <p>
          {{ t('newTask.branchSelect.dirtyWarning', { branch: pendingDirtyBranch, count: dirtyCount }) }}
        </p>
        <div class="flex justify-end gap-2">
          <Button
            data-testid="dirty-confirm-cancel"
            variant="secondary"
            class="h-7 px-2.5 text-[12px]"
            @click="cancelDirty"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            data-testid="dirty-confirm-ok"
            class="h-7 px-2.5 text-[12px]"
            @click="confirmDirtySwitch"
          >
            {{ t('newTask.branchSelect.switchAway') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- ───── Worktree panel ───── -->
    <div v-show="activeTab === 'worktree'">
      <!-- 空态：无 worktree（新建 worktree 动作仍 accent 强调在底部） -->
      <div
        v-if="props.worktreeItems.length === 0"
        data-testid="wt-empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <GitFork class="size-5 text-subtle" />
        <p class="text-[12px] text-muted">{{ t('newTask.dirSelect.noWorktrees') }}</p>
      </div>

      <!-- worktree 列表（GitFork + 分支名 + mono 路径副标题 + HEAD 徽章，风格与 DirSelectPopover 一致） -->
      <div
        v-else
        class="py-1"
      >
        <PopoverListItem
          v-for="(wt, wi) in props.worktreeItems"
          :key="wt.path"
          test-id="worktree-item"
          :active="isActiveItem(wi)"
          :selected="wt.HEAD"
          @click="selectWorktree(wt.path)"
          @mouseenter="activeIndex = wi"
        >
          <template #icon>
            <GitFork class="shrink-0 text-subtle" />
          </template>
          <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span class="flex items-center gap-1.5 truncate text-fg">
              <span class="truncate">{{ wt.branch }}</span>
              <span
                v-if="wt.HEAD"
                class="rounded bg-accent-soft px-1 py-px font-mono text-[10px] font-semibold text-accent"
              >HEAD</span>
            </span>
            <span class="truncate font-mono text-[11px] text-subtle">{{ wt.path }}</span>
          </span>
        </PopoverListItem>
      </div>

      <div class="my-1 h-px bg-border" />

      <!-- 动作项：新建 worktree（accent 强调，git repo 推荐入口） -->
      <PopoverActionItem
        test-id="action-create-worktree"
        class="bg-accent-soft"
        :active="isActiveItem(props.worktreeItems.length)"
        @click="createWorktree"
        @mouseenter="activeIndex = props.worktreeItems.length"
      >
        <template #icon>
          <GitFork class="shrink-0 text-accent" />
        </template>
        {{ t('newTask.dirSelect.createWorktree') }}
      </PopoverActionItem>
    </div>
  </div>
</template>
