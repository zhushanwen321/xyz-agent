<script setup lang="ts">
/**
 * BranchSelectPopover.vue —— 步骤3 选分支 popover（#6，spec §3.3）。
 *
 * 形态：popover 内容面板（宽度 420px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：onMounted → gitApi.status(sessionId) → GitStatusResult。
 * - unborn HEAD（T4.3 / AC-6.3）：isRepo=true 且 branches=[] → 空态引导首次 commit
 * - getStatus 失败（T4.6 / AC-6.4）：reject → 显错不崩
 * - 分支 100+（T4.9 / AC-6.9）：渲染上限 + 搜索过滤
 *
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选干净分支 → emit('select', { name })（父接 useNewTaskFlow.selectBranch）
 * - dirty 工作区选其它分支 → inline 二次确认条 → 确认 emit('confirm-dirty-switch', { name })
 *   （父接 useNewTaskFlow.confirmDirtySwitch，v1「留在工作区」不 stash，spec §3.3）
 * - 「创建并检出新分支」→ emit('open-branch-modal')（父接 useNewTaskFlow.openBranchModal）
 * - 「Git 图谱」→ v1 stub toast（spec §6 / issues #12 P3 延后）
 * - Esc → emit('close')
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { GitBranch, Plus, GitGraph, TriangleAlert, Check } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { git as gitApi } from '@/api'
import { useToast } from '@/composables/useToast'
import type { GitStatusResult } from '@xyz-agent/shared'

/** T4.9 / AC-6.9：分支极多时渲染上限，超出靠搜索过滤（v1 限制渲染数，不引入虚拟滚动库） */
const MAX_RENDER_BRANCHES = 50
/** 扁平化键盘导航的尾部动作项数（创建并检出新分支 + Git 图谱） */
const ACTION_ITEM_COUNT = 2
/** spec §6：Git 图谱 v1 stub（issues #12 P3） */
const GIT_GRAPH_UNSUPPORTED_MSG = 'v1 暂未支持 Git 图谱'

const props = defineProps<{
  /** 当前 session id（拉取 git status 用） */
  sessionId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', payload: { name: string }): void
  (e: 'confirm-dirty-switch', payload: { name: string }): void
  (e: 'open-branch-modal'): void
  (e: 'close'): void
}>()

const { error: toastError } = useToast()

const status = ref<GitStatusResult | null>(null)
const statusError = ref<unknown>(null)
const search = ref('')
const root = ref<HTMLElement | null>(null)
const activeIndex = ref(0)
/** dirty 二次确认条待确认的目标分支名（null = 无确认条） */
const pendingDirtyBranch = ref<string | null>(null)

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

function isActiveItem(idx: number): boolean {
  return idx === activeIndex.value
}

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
  toastError(GIT_GRAPH_UNSUPPORTED_MSG)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  const total = filtered.value.length + ACTION_ITEM_COUNT
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % total
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + total) % total
  } else if (e.key === 'Enter') {
    e.preventDefault()
    activate(activeIndex.value)
  }
}

function activate(idx: number): void {
  const listLen = filtered.value.length
  if (idx < listLen) selectBranch(filtered.value[idx])
  else if (idx === listLen) openBranchModal()
  else gitGraphStub()
}
</script>

<template>
  <div
    ref="root"
    data-testid="branch-select-popover"
    class="w-[420px] overflow-hidden rounded-md border border-border-strong bg-bg-elevated shadow-2 outline-none"
    @keydown="onKeydown"
  >
    <!-- 搜索 input -->
    <div class="border-b border-border p-2">
      <Input
        v-model="search"
        placeholder="搜索分支"
        class="h-8 bg-surface-2 text-[13px]"
      />
    </div>

    <!-- getStatus 失败（T4.6） -->
    <div
      v-if="statusError"
      data-testid="status-error"
      class="flex items-center gap-2 px-3 py-4 text-[12.5px] text-danger"
    >
      <TriangleAlert class="size-4 shrink-0" />
      <span>加载分支失败，请重试</span>
    </div>

    <!-- unborn HEAD 空态（T4.3） -->
    <div
      v-else-if="isUnborn"
      data-testid="empty-state"
      class="flex flex-col items-center gap-2 px-4 py-6 text-center"
    >
      <GitBranch class="size-5 text-subtle" />
      <p class="text-[12.5px] text-muted">无分支 · 引导首次 commit</p>
    </div>

    <!-- 分支列表 -->
    <div v-else class="py-1">
      <div class="flex items-center justify-between px-3 py-1 text-[11px] text-subtle">
        <span>分支</span>
        <span>{{ allBranches.length }}</span>
      </div>

      <Button
        v-for="(name, i) in filtered"
        :key="name"
        data-testid="branch-item"
        :data-active="name === currentBranch"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="[
          name === currentBranch ? 'bg-surface-2 ring-1 ring-inset ring-accent-ring' : '',
          isActiveItem(i) ? 'bg-surface-hover' : '',
        ]"
        @click="selectBranch(name)"
        @mouseenter="activeIndex = i"
      >
        <GitBranch class="shrink-0 text-subtle" />
        <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span class="truncate font-mono text-fg">{{ name }}</span>
          <!-- 当前分支 dirty subline（spec §3.3 warning dot + mono 小字） -->
          <span
            v-if="name === currentBranch && isDirty"
            class="flex items-center gap-1 text-[11px] text-warning"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-warning" />
            未提交的更改：{{ dirtyCount }} 个文件
          </span>
        </span>
        <Check
          v-if="name === currentBranch"
          class="size-4 shrink-0 text-accent"
        />
      </Button>

      <div class="my-1 h-px bg-border" />

      <!-- 动作项：创建并检出新分支 -->
      <Button
        data-testid="action-create-branch"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="isActiveItem(filtered.length) ? 'bg-surface-hover' : ''"
        @click="openBranchModal"
        @mouseenter="activeIndex = filtered.length"
      >
        <Plus class="shrink-0 text-subtle" />
        <span>创建并检出新分支...</span>
      </Button>

      <!-- 动作项：Git 图谱（v1 stub） -->
      <Button
        data-testid="action-git-graph"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="isActiveItem(filtered.length + 1) ? 'bg-surface-hover' : ''"
        @click="gitGraphStub"
        @mouseenter="activeIndex = filtered.length + 1"
      >
        <GitGraph class="shrink-0 text-subtle" />
        <span>Git 图谱</span>
      </Button>
    </div>

    <!-- dirty inline 二次确认条（spec §3.3，非 modal） -->
    <div
      v-if="pendingDirtyBranch"
      data-testid="dirty-confirm"
      class="flex flex-col gap-2 border-t border-warning/40 bg-warning/10 px-3 py-2.5 text-[12px] text-fg"
    >
      <p>
        「{{ pendingDirtyBranch }}」当前工作区有 {{ dirtyCount }} 个未提交更改，切走将保留在工作区。
      </p>
      <div class="flex justify-end gap-2">
        <Button
          data-testid="dirty-confirm-cancel"
          variant="secondary"
          class="h-7 px-2.5 text-[12px]"
          @click="cancelDirty"
        >
          取消
        </Button>
        <Button
          data-testid="dirty-confirm-ok"
          class="h-7 px-2.5 text-[12px]"
          @click="confirmDirtySwitch"
        >
          切走
        </Button>
      </div>
    </div>
  </div>
</template>
