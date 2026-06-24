<!--
  GitZone —— Panel zone ⑤（panel/spec.md，FR-12 / issues.md #3 / code-architecture §4.1）。
  渲染 cwd 的全量 git 状态：四态 pill + 分支 + stats + 文件列表 + 暂存/提交操作。

  四态派生（优先级 conflict > dirty > staged > clean）：
  - conflict: hasConflict（红）
  - dirty:    unstagedCount > 0（橙）
  - staged:   stagedCount > 0 且 unstagedCount === 0（accent）
  - clean:    staged/unstaged 均为 0（绿）

  数据源：api git.status（real 走 transport，mock 走 fixture）。刷新时机（G-R2-04）：
  进入 session + agent_end 后 + stage/unstage/commit 操作后手动刷（非轮询）。
  非 git 仓库（isRepo=false）→ 隐藏整个 zone（G-R2-05）。

  commit message 用 xyz-ui Input（§6.3 点1，禁止原生 input）。
-->
<template>
  <section
    v-if="result?.isRepo"
    class="relative flex flex-col gap-1.5 overflow-hidden border-t border-border px-3 py-2 text-[12px]"
    :class="result.hasConflict ? 'bg-danger/8' : ''"
  >
    <!-- 冲突态 danger 竖条（FR-12 item 2，draft-companion-zones §2） -->
    <div
      v-if="result.hasConflict"
      class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-danger"
      aria-hidden="true"
    />
    <!-- soft 渐隐底（FR-12 item 2） -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 h-2 bg-gradient-to-b from-[var(--bg)]/40 to-transparent"
      aria-hidden="true"
    />
    <!-- 头部：分支 + 四态 pill + stats -->
    <div class="relative flex items-center gap-2">
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
      <!-- Diff / 解决冲突按钮：git-zone Diff 按钮是 SideDrawer 的触发源（C9 / §4.10 F10）。
           SideDrawer 不含 Diff tab（审批 Out-of-scope），点击打开默认 Terminal tab。
           conflict 态用警示图标 + danger 色，非 conflict 用 diff 比较图标。 -->
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0"
        :class="result.hasConflict ? 'text-danger hover:text-danger' : 'text-subtle hover:text-fg'"
        :title="result.hasConflict ? '解决冲突（侧栏）' : '在侧栏查看'"
        @click="emit('open-side-drawer')"
      >
        <TriangleAlert v-if="result.hasConflict" class="size-3" />
        <GitCompare v-else class="size-3" />
      </Button>
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
    <ul v-if="result.files.length" class="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
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

    <!-- 操作区：commit message + stage/unstage/commit -->
    <div class="flex items-center gap-1.5">
      <Input
        v-model="commitMsg"
        class="h-7 flex-1 text-[11px]"
        placeholder="commit message"
        :disabled="pending"
        @keydown.enter="onCommit"
      />
      <Button
        variant="ghost"
        class="h-7 shrink-0 rounded-sm px-2 text-[11px]"
        :disabled="pending || result.unstagedCount === 0"
        title="暂存全部改动"
        @click="onStageAll"
      >Stage</Button>
      <Button
        variant="ghost"
        class="h-7 shrink-0 rounded-sm px-2 text-[11px]"
        :disabled="pending || result.stagedCount === 0"
        title="取消全部暂存"
        @click="onUnstageAll"
      >Unstage</Button>
      <Button
        class="h-7 shrink-0 rounded-sm px-2 text-[11px]"
        :disabled="!canCommit"
        :title="result.hasConflict ? '存在冲突，解决后才能提交' : '提交暂存区'"
        @click="onCommit"
      >Commit</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, watch, onScopeDispose } from 'vue'
import { GitBranch, RefreshCw, GitCompare, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { git as gitApi } from '@/api'
import { on as onSessionEvent } from '@/api/events'
import type { ServerMessage, GitStatusResult, GitFileStatus } from '@xyz-agent/shared'

const props = defineProps<{ sessionId: string }>()

/** SideDrawer 触发：git-zone Diff 按钮 emit，Panel 经 useSideDrawer 打开（§4.10 F10） */
const emit = defineEmits<{
  'open-side-drawer': []
}>()

const result = ref<GitStatusResult | null>(null)
const pending = ref(false)
const error = ref('')
const commitMsg = ref('')

/** 四态派生（优先级 conflict > dirty > staged > clean） */
const state = computed<'conflict' | 'dirty' | 'staged' | 'clean'>(() => {
  if (!result.value) return 'clean'
  if (result.value.hasConflict) return 'conflict'
  if (result.value.unstagedCount > 0) return 'dirty'
  if (result.value.stagedCount > 0) return 'staged'
  return 'clean'
})

const pillLabel = computed(() => ({ clean: 'Clean', staged: 'Staged', dirty: 'Dirty', conflict: 'Conflict' })[state.value])
const pillClass = computed(() => ({
  clean: 'bg-success/12 text-success',
  staged: 'bg-success/12 text-success',
  dirty: 'bg-warning/14 text-warning',
  conflict: 'bg-danger/14 text-danger',
}[state.value]))

/** 可提交：非冲突 + 非空 message + 非 pending（runtime 要求非空 message） */
const canCommit = computed(() => !pending.value && !result.value?.hasConflict && commitMsg.value.trim().length > 0)

async function refresh(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    result.value = await gitApi.status(props.sessionId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pending.value = false
  }
}

async function onStageAll(): Promise<void> {
  await runOp(() => gitApi.stage(props.sessionId))
}

async function onUnstageAll(): Promise<void> {
  await runOp(() => gitApi.unstage(props.sessionId))
}

async function onCommit(): Promise<void> {
  if (!canCommit.value) return
  const msg = commitMsg.value.trim()
  await runOp(async () => {
    await gitApi.commit(props.sessionId, msg)
    commitMsg.value = ''
  })
}

/** 统一操作包装：pending guard + 错误回显 + 成功后刷新 status */
async function runOp(fn: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    await fn()
    result.value = await gitApi.status(props.sessionId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pending.value = false
  }
}

function statusBadge(status: GitFileStatus['status']): string {
  return ({ added: 'A', modified: 'M', deleted: 'D', unmerged: 'U', renamed: 'R', untracked: '?' })[status]
}

function statusBadgeClass(status: GitFileStatus['status']): string {
  return ({
    added: 'text-success',
    modified: 'text-warning',
    deleted: 'text-danger',
    unmerged: 'text-danger font-bold',
    renamed: 'text-accent',
    untracked: 'text-subtle',
  })[status]
}

// 切换 session 时重置并刷新
watch(() => props.sessionId, () => {
  result.value = null
  commitMsg.value = ''
  error.value = ''
  refresh()
}, { immediate: true })

// agent_end 后刷新（G-R2-04/C14）：agent 改动文件后 git 状态变 stale，回合结束时重拉。
// 订阅会话级 message.complete（agent 回合结束），随 sessionId 变化重建订阅，避免轮询/filesystem watch。
let unsubComplete: (() => void) | null = null
watch(() => props.sessionId, (sid) => {
  unsubComplete?.()
  unsubComplete = onSessionEvent(sid, (msg: ServerMessage) => {
    if (msg.type === 'message.complete') {
      refresh()
    }
  })
}, { immediate: true })
onScopeDispose(() => unsubComplete?.())
</script>
