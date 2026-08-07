<script setup lang="ts">
/**
 * CreateBranchModal.vue —— 步骤4b 创建并检出新分支 modal（#7，spec §3.5 / §4.4）。
 *
 * 数据流：state===branch-modal 渲染 → 前端实时校验（git 分支名规则，AC-7.8）→
 * 提交 useNewTaskFlow.submitCreateBranch（[内] gitApi.createBranch）。
 * - 非法名 → 提交 disabled + 格式错误提示
 * - 飞行中 disabled 防重复（AC-7.9，绑 composable isBranchCreating）
 * - 失败留 modal 显错可重试（D-7/AC-7.3）；超时显「git 操作超时」（AC-7.7）
 * - Esc/X/遮罩 → closeOverlay（branch-modal→landing）
 *
 * 分支名双重校验：前端实时（本组件 isValid）+ runtime 二次（GitService，T6.8）。
 * 渲染绑定：父级（Landing）按 state==='branch-modal' 挂载本组件（与 popover 同模式）。
 */
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
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

/** 合法分支名规则（与 runtime GitService 一致，AC-7.8）：字母/数字开头，禁 .. 与空格等 */
const VALID_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/

const { t } = useI18n()
const flow = useNewTaskFlow()
const branchName = ref('')
const errorMsg = ref('')
const inputRef = ref<InstanceType<typeof Input> | null>(null)

const trimmedName = computed(() => branchName.value.trim())
const isValid = computed(() => {
  const n = trimmedName.value
  return n.length > 0 && VALID_BRANCH_NAME.test(n) && !n.includes('..')
})
/** 输入了内容但不合法 → 显格式错误（空时靠 placeholder 引导，不报红） */
const showFormatError = computed(() => branchName.value.length > 0 && !isValid.value)
const canSubmit = computed(() => isValid.value && !flow.isBranchCreating.value)

const isOpen = computed(() => flow.state.value === 'branch-modal')

/** Dialog open 变化：false（Esc/X/遮罩）→ closeOverlay（branch-modal→landing） */
function onOpenChange(v: boolean): void {
  if (!v) flow.closeOverlay()
}

/** 重新打开时重置表单（成功落回 landing 后再开为新实例） */
watch(isOpen, (open) => {
  if (open) {
    branchName.value = ''
    errorMsg.value = ''
  }
})

onMounted(() => {
  // spec §3.5：打开即 focus input（Dialog teleport 后 nextTick 取 $el）
  nextTick(() => {
    const el = inputRef.value?.$el as HTMLInputElement | undefined
    el?.focus()
  })
})

/** 从 reject 错误提取用户可读信息（runtime GitError code 经 envelope 透传） */
function branchErrMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // runtime 超时 → GitError('git_unavailable')，envelope 透传 code/message
  if (/git_unavailable|timeout|超时/i.test(msg)) return t('newTask.createBranch.gitTimeout')
  return msg || t('newTask.createBranch.createFailed')
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  errorMsg.value = ''
  try {
    await flow.submitCreateBranch(trimmedName.value)
    // 成功 → composable 已 transition('landing')，isOpen 变 false，Dialog 关
  } catch (e) {
    errorMsg.value = branchErrMsg(e) // D-7：留 modal 显错，state 不变
  }
}

function onCancel(): void {
  flow.closeOverlay()
}
</script>

<template>
  <Dialog :open="isOpen" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ t('newTask.createBranch.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('newTask.createBranch.desc') }}
        </DialogDescription>
      </DialogHeader>

      <form class="mt-2 space-y-3" @submit.prevent="onSubmit">
        <div class="space-y-1.5">
          <Label for="branch-name-input">{{ t('newTask.createBranch.nameLabel') }}</Label>
          <Input
            id="branch-name-input"
            ref="inputRef"
            v-model="branchName"
            :placeholder="t('newTask.createBranch.namePlaceholder')"
            autocomplete="off"
            :class="showFormatError || !!errorMsg ? '!border-danger' : ''"
          />
          <p
            v-if="showFormatError"
            data-testid="branch-name-error"
            class="text-[12px] text-danger"
          >
            {{ t('newTask.createBranch.nameValidation') }}
          </p>
        </div>

        <p class="text-[12px] text-subtle">{{ t('newTask.createBranch.onlyHeadHint') }}</p>

        <!-- 提交失败错误（D-7 留 modal 显错） -->
        <p v-if="errorMsg" data-testid="error-msg" class="text-[12px] text-danger">
          {{ errorMsg }}
        </p>

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" @click="onCancel">{{ t('common.cancel') }}</Button>
          <Button data-testid="submit-btn" type="submit" :disabled="!canSubmit">
            {{ t('newTask.createBranch.createBtn') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
