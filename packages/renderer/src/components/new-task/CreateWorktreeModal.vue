<script setup lang="ts">
/**
 * CreateWorktreeModal.vue —— 创建 worktree modal（W2 wave，spec §3.6 / §4.4）。
 *
 * 五态状态机（内部自管，与 flow.state 解耦——组件由父级按 state==='worktree-modal' 挂载）：
 *   form → progress → success / error / exists
 *
 * 数据流：
 * - form：分支名输入（实时校验 git ref 规则）+ base 选择（current / origin/main，默认 main）+
 *         目录名预览（/ → -）。点创建 → progress。
 * - progress：调 worktreeApi.create → 成功转 success；失败按 code 转 error / exists。
 * - success：显示成功提示，2s 后 emit('success', cwd) + emit('close')。
 * - error（SETUP_FAILED / GIT_FAILED / NOT_BARE_REPO）：显示失败步骤 + stderr + 重试/清理。
 * - exists（WORKTREE_EXISTS）：显示「已存在」+ 直接开始（用已存在 worktree 的 cwd）。
 *
 * emits：
 * - close：取消/关闭（form 态点取消、success 2s 后、progress 不可关闭）
 * - success(cwd)：创建成功后 emit（父接 flow.selectWorkspace + flow.closeOverlay）
 * - use-existing(cwd)：exists 态点「直接开始」emit
 *
 * 依赖：useNewTaskFlow（gitInfo.branch 回灌 base current 文案）、worktreeApi（RPC）。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Check, AlertTriangle, ChevronDown, ChevronRight } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { worktreeApi } from '@/api/domains/worktree'

/** 兼容 DeepReadonly Ref 形态的 flow（测试 mock 注入 readonly ref，生产为 ComputedRef） */
interface FlowLike {
  gitInfo: { value: { branch: string } | null }
}

/** worktreeApi.create 失败错误（envelope 透传 code/detail） */
interface WorktreeError {
  code?: string
  message?: string
  cwd?: string
  exitCode?: number
  stderr?: string
}

/** 五态 */
type ModalPhase = 'form' | 'progress' | 'success' | 'error' | 'exists'

/** progress 态步骤定义（MVP：create 是 await 到全部完成，步骤只展示不联调状态） */
interface ProgressStep {
  testid: string
  label: string
}

/** success 态 emit success 前的延迟（让用户看到成功提示） */
const SUCCESS_EMIT_DELAY_MS = 2000

/** 分支名非法字符/形态规则（与 runtime GitService 一致）：
 *  - 含 .. / 空格 / ~ / ^ / :
 *  - 以 . 或 - 开头
 *  正则匹配任一即非法。 */
const INVALID_BRANCH_REGEX = /(^\.|^-|\.\.|[~^:]|\s)/

/** base 分支默认值（D3 决策：origin/main） */
const DEFAULT_BASE = 'origin/main' as const

const props = defineProps<{
  /** 初始分支名（可选，回灌用） */
  initialBranch?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'success', cwd: string): void
  (e: 'use-existing', cwd: string): void
}>()

const { t } = useI18n()
const flow = useNewTaskFlow() as unknown as FlowLike

// ── form 态 ──
const branchName = ref(props.initialBranch ?? '')
const baseBranch = ref<'current' | 'origin/main'>(DEFAULT_BASE)
const inputRef = ref<InstanceType<typeof Input> | null>(null)

// ── 状态机 ──
const phase = ref<ModalPhase>('form')
/** worktreeApi.create 成功返回的 cwd（success 态 emit 用） */
const successCwd = ref<string>('')
/** worktreeApi.create 失败错误对象（error/exists 态展示用） */
const lastError = ref<WorktreeError | null>(null)
/** progress 实时输出折叠开关 */
const logExpanded = ref(false)

/** 成功态 2s 后 emit 的定时器句柄（卸载/重置时清理） */
let successTimer: ReturnType<typeof setTimeout> | null = null

const trimmedName = computed(() => branchName.value.trim())

/** 分支名是否合法（非空 + 不匹配非法正则） */
const isBranchValid = computed(() => {
  const n = trimmedName.value
  return n.length > 0 && !INVALID_BRANCH_REGEX.test(n)
})

/** 输入了内容但不合法 → 显格式错误（空时靠 placeholder 引导） */
const showFormatError = computed(() => branchName.value.length > 0 && !isBranchValid.value)

/** 创建按钮可点：form 态 + 分支名合法 + 非创建中 */
const canSubmit = computed(() => phase.value === 'form' && isBranchValid.value)

/** 目录名预览：分支名 / → -（与 runtime 派生规则一致） */
const dirPreview = computed(() => {
  const n = trimmedName.value
  if (!n) return ''
  return n.replace(/\//g, '-')
})

/** 当前分支名（base current 文案 + workspaceHint 兜底） */
const currentBranch = computed(() => flow.gitInfo.value?.branch ?? 'main')

/** progress 态步骤列表（3 步：创建分支 / 检出目录 / 运行 setup 脚本） */
const progressSteps = computed<ProgressStep[]>(() => [
  { testid: 'worktree-step-0', label: t('newTask.createWorktree.stepCreateBranch') },
  { testid: 'worktree-step-1', label: t('newTask.createWorktree.stepCheckoutDir') },
  { testid: 'worktree-step-2', label: t('newTask.createWorktree.stepRunSetup') },
])

/** Dialog open：组件挂载即开（父级按 state 控制挂载，Dialog 内只管自身 open=true） */
const isOpen = computed(() => true)

/** Dialog open 变化：progress 态不可关闭（D4 决策）；其他态 false → emit close */
function onOpenChange(v: boolean): void {
  if (v) return
  // progress 态：忽略外部关闭（防止误点遮罩中断创建）
  if (phase.value === 'progress') return
  emit('close')
}

/** 选 base：segmented 点击 */
function selectBase(b: 'current' | 'origin/main'): void {
  baseBranch.value = b
}

/** 提交创建：form → progress → 调 worktreeApi.create → success/error/exists */
async function submitCreate(): Promise<void> {
  if (!canSubmit.value) return
  await runCreate(trimmedName.value, baseBranch.value)
}

/**
 * 调 worktreeApi.create 并按结果切态。
 * 重试也走此路径（用上次提交的 branch + baseBranch）。
 */
async function runCreate(branch: string, base: 'current' | 'origin/main'): Promise<void> {
  phase.value = 'progress'
  lastError.value = null
  logExpanded.value = false
  try {
    const result = await worktreeApi.create({
      branch,
      baseBranch: base,
    })
    // 成功 → success 态，2s 后 emit success + close
    successCwd.value = result.cwd
    phase.value = 'success'
    scheduleSuccessEmit(result.cwd)
  } catch (e) {
    const err = (e as WorktreeError) ?? {}
    lastError.value = err
    if (err.code === 'WORKTREE_EXISTS') {
      phase.value = 'exists'
    } else {
      phase.value = 'error'
    }
  }
}

/** 安排 success 态 2s 后 emit success + close（CM-6 时序契约） */
function scheduleSuccessEmit(cwd: string): void {
  clearSuccessTimer()
  successTimer = setTimeout(() => {
    emit('success', cwd)
    emit('close')
  }, SUCCESS_EMIT_DELAY_MS)
}

function clearSuccessTimer(): void {
  if (successTimer != null) {
    clearTimeout(successTimer)
    successTimer = null
  }
}

/** error 态重试：用上次提交参数重新调 create */
async function onRetry(): Promise<void> {
  // 用当前表单值（用户可能改过分支名，但典型场景是同分支重试）
  await runCreate(trimmedName.value, baseBranch.value)
}

/** error 态清理：emit close（父级负责真清理，MVP 只关 modal） */
function onCleanup(): void {
  emit('close')
}

/** exists 态「直接开始」：emit use-existing(已存在 cwd) */
function onUseExisting(): void {
  const cwd = lastError.value?.cwd ?? successCwd.value
  if (cwd) emit('use-existing', cwd)
}

/** 取消（form 态） */
function onCancel(): void {
  emit('close')
}

onMounted(() => {
  // form 态打开即 focus input（Dialog teleport 后 nextTick 取 $el）
  nextTick(() => {
    const el = inputRef.value?.$el as HTMLInputElement | undefined
    el?.focus()
  })
})

onBeforeUnmount(() => {
  clearSuccessTimer()
})
</script>

<template>
  <Dialog :open="isOpen" @update:open="onOpenChange">
    <DialogContent
      data-testid="create-worktree-modal"
      class="sm:max-w-[560px]"
      :hide-close="phase === 'progress'"
    >
      <DialogHeader>
        <DialogTitle>{{ t('newTask.createWorktree.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('newTask.createWorktree.desc') }}
        </DialogDescription>
      </DialogHeader>

      <!-- ── form 态：分支名 + base + 预览 + 创建/取消 ── -->
      <div v-if="phase === 'form'" class="mt-2 space-y-4">
        <div class="space-y-1.5">
          <Label for="worktree-branch-input">{{ t('newTask.createWorktree.branchLabel') }}</Label>
          <Input
            id="worktree-branch-input"
            ref="inputRef"
            v-model="branchName"
            data-testid="worktree-branch-input"
            :placeholder="t('newTask.createWorktree.branchPlaceholder')"
            autocomplete="off"
            :class="showFormatError ? '!border-destructive' : ''"
          />
          <p
            v-if="showFormatError"
            data-testid="worktree-branch-error"
            class="text-[12px] text-danger"
          >
            {{ t('newTask.createWorktree.branchValidation') }}
          </p>
        </div>

        <!-- 目录名预览（/ → -） -->
        <div class="space-y-1">
          <p class="text-[12px] text-subtle">{{ t('newTask.createWorktree.dirPreviewLabel') }}</p>
          <p
            data-testid="worktree-dir-preview"
            class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-fg"
          >
            {{ dirPreview || '—' }}
          </p>
        </div>

        <!-- base 分支 segmented（默认 origin/main） -->
        <div class="space-y-1">
          <p class="text-[12px] text-subtle">{{ t('newTask.createWorktree.baseLabel') }}</p>
          <div class="inline-flex rounded-md border border-border p-0.5">
            <Button
              variant="ghost"
              data-testid="worktree-base-current"
              :aria-checked="baseBranch === 'current'"
              :class="[
                'h-auto rounded px-3 py-1 text-[12px]',
                baseBranch === 'current'
                  ? 'bg-accent text-white hover:bg-accent selected active checked'
                  : 'text-muted hover:bg-surface-hover',
              ]"
              @click="selectBase('current')"
            >
              {{ t('newTask.createWorktree.baseCurrent', { branch: currentBranch }) }}
            </Button>
            <Button
              variant="ghost"
              data-testid="worktree-base-main"
              :aria-checked="baseBranch === 'origin/main'"
              :class="[
                'h-auto rounded px-3 py-1 text-[12px]',
                baseBranch === 'origin/main'
                  ? 'bg-accent text-white hover:bg-accent selected active checked'
                  : 'text-muted hover:bg-surface-hover',
              ]"
              @click="selectBase('origin/main')"
            >
              {{ t('newTask.createWorktree.baseMain') }}
            </Button>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            data-testid="worktree-cancel-btn"
            @click="onCancel"
          >
            {{ t('newTask.createWorktree.cancelBtn') }}
          </Button>
          <Button
            type="button"
            data-testid="worktree-create-btn"
            :disabled="!canSubmit"
            @click="submitCreate"
          >
            {{ t('newTask.createWorktree.createBtn') }}
          </Button>
        </div>
      </div>

      <!-- ── progress 态：loading bar + 3 步 + log toggle（无关闭 X） ── -->
      <div v-else-if="phase === 'progress'" class="mt-2 space-y-3">
        <!-- 顶部 loading bar -->
        <div
          data-testid="worktree-loading-bar"
          class="h-1 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div class="h-full w-1/3 animate-pulse rounded-full bg-accent"></div>
        </div>

        <!-- 3 步列表（MVP：create 是 await 到完成，无法实时联调每步状态，统一显进行中） -->
        <ul class="space-y-2">
          <li
            v-for="(step, idx) in progressSteps"
            :key="step.testid"
            :data-testid="step.testid"
            class="flex items-center gap-2 text-[13px]"
          >
            <Loader2 class="size-4 animate-spin text-accent" />
            <span class="text-fg">{{ step.label }}</span>
            <span v-if="idx === progressSteps.length - 1" class="ml-auto text-[11px] text-subtle">
              ...
            </span>
          </li>
        </ul>

        <!-- 实时输出折叠开关（MVP：占位 UI，输出源待 runtime stream 接通） -->
        <Button
          variant="ghost"
          data-testid="worktree-log-toggle"
          class="h-auto w-full justify-start gap-1 rounded px-1 py-0.5 text-[12px] text-subtle"
          @click="logExpanded = !logExpanded"
        >
          <ChevronDown v-if="logExpanded" class="size-3.5" />
          <ChevronRight v-else class="size-3.5" />
          {{ t('newTask.createWorktree.showLog') }}
        </Button>
      </div>

      <!-- ── success 态：成功图标 + 提示 ── -->
      <div v-else-if="phase === 'success'" data-testid="worktree-success" class="mt-2 space-y-3">
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-full bg-accent-soft">
            <Check class="size-5 text-accent" />
          </div>
          <div class="space-y-0.5">
            <p class="text-[14px] font-medium text-fg">
              {{ t('newTask.createWorktree.successTitle') }}
            </p>
            <p class="text-[12px] text-subtle">{{ t('newTask.createWorktree.successDesc') }}</p>
          </div>
        </div>
      </div>

      <!-- ── error 态：失败步骤 + stderr + 重试/清理 ── -->
      <div v-else-if="phase === 'error'" class="mt-2 space-y-3">
        <div class="flex items-start gap-2">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-danger" />
          <div data-testid="worktree-step-failed" class="min-w-0 flex-1 space-y-1">
            <p class="text-[13px] font-medium text-fg">
              {{ t('newTask.createWorktree.failedStep') }}
            </p>
            <p v-if="lastError?.code" class="text-[11px] text-subtle">
              code: {{ lastError.code }}
              <template v-if="lastError.exitCode != null"> · exit {{ lastError.exitCode }}</template>
            </p>
          </div>
        </div>

        <!-- 错误输出（stderr） -->
        <pre
          v-if="lastError?.stderr"
          data-testid="worktree-error-output"
          class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-fg"
          >{{ lastError.stderr }}</pre
        >
        <pre
          v-else
          data-testid="worktree-error-output"
          class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-fg"
          >{{ lastError?.message ?? '' }}</pre
        >

        <div class="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            data-testid="worktree-cleanup-btn"
            @click="onCleanup"
          >
            {{ t('newTask.createWorktree.cleanupBtn') }}
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid="worktree-retry-btn"
            class="primary"
            @click="onRetry"
          >
            {{ t('newTask.createWorktree.retryBtn') }}
          </Button>
        </div>
      </div>

      <!-- ── exists 态：已存在提示 + 直接开始 ── -->
      <div v-else-if="phase === 'exists'" class="mt-2 space-y-3">
        <div
          data-testid="worktree-exists-notice"
          class="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-3"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" />
          <p class="text-[13px] text-fg">{{ t('newTask.createWorktree.existsNotice') }}</p>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            data-testid="worktree-cancel-btn"
            @click="onCancel"
          >
            {{ t('newTask.createWorktree.cancelBtn') }}
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid="worktree-use-existing-btn"
            @click="onUseExisting"
          >
            {{ t('newTask.createWorktree.useExistingBtn') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
