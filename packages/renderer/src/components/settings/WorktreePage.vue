<!--
  Settings · Worktree 配置页。
  三个 section：普通 git 仓库 / bare-workspace / 通用。
  所有设置项变更后立即通过 WS 同步到 runtime（乐观更新 + 失败回滚）。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- Section 1：普通 git 仓库 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.worktree.sectionPlainRepo') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.worktree.sectionPlainRepoDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 专用目录 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-fg">{{ t('settings.worktree.worktreeRootDir') }}</Label>
            <span class="text-[10px] text-muted">{{ t('settings.worktree.worktreeRootDirHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <Input
              v-model="worktreeRootDir"
              :placeholder="t('settings.worktree.worktreeRootDirPlaceholder')"
              class="h-8 w-[240px] text-[12px]"
              @blur="onSaveWorktreeRootDir"
            />
            <Button
              variant="ghost"
              class="h-8 px-2 text-[11px] text-accent hover:bg-transparent hover:underline"
              @click="onBrowseWorktreeRootDir"
            >
              {{ t('settings.worktree.browse') }}
            </Button>
          </div>
        </div>
        <!-- 初始化脚本 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-fg">{{ t('settings.worktree.setupScript') }}</Label>
            <span class="text-[10px] text-muted">{{ t('settings.worktree.setupScriptHint') }}</span>
          </div>
          <Input
            v-model="setupScript"
            :placeholder="t('settings.worktree.setupScriptPlaceholder')"
            class="h-8 w-[280px] text-[12px]"
            @blur="onSaveSetupScript"
          />
        </div>
      </div>
    </div>

    <!-- Section 2：bare-workspace -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.worktree.sectionBareWorkspace') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.worktree.sectionBareWorkspaceDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 初始化脚本 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-fg">{{ t('settings.worktree.bareSetupScript') }}</Label>
            <span class="text-[10px] text-muted">{{ t('settings.worktree.bareSetupScriptHint') }}</span>
          </div>
          <Input
            v-model="bareSetupScript"
            :placeholder="t('settings.worktree.bareSetupScriptPlaceholder')"
            class="h-8 w-[280px] text-[12px]"
            @blur="onSaveBareSetupScript"
          />
        </div>
        <!-- 超时时间 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-fg">{{ t('settings.worktree.timeout') }}</Label>
            <span class="text-[10px] text-muted">{{ t('settings.worktree.timeoutHint') }}</span>
          </div>
          <Input
            v-model.number="timeout"
            type="number"
            :placeholder="t('settings.worktree.timeoutPlaceholder')"
            class="h-8 w-[120px] text-[12px]"
            min="1"
            @blur="onSaveTimeout"
          />
        </div>
      </div>
    </div>

    <!-- Section 3：通用 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.worktree.sectionGeneral') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.worktree.sectionGeneralDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 默认基分支 -->
        <div class="flex items-center justify-between px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <Label class="text-[12px] text-fg">{{ t('settings.worktree.defaultBaseBranch') }}</Label>
            <span class="text-[10px] text-muted">{{ t('settings.worktree.defaultBaseBranchHint') }}</span>
          </div>
          <Input
            v-model="defaultBaseBranch"
            :placeholder="t('settings.worktree.defaultBaseBranchPlaceholder')"
            class="h-8 w-[200px] text-[12px]"
            @blur="onSaveDefaultBaseBranch"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/composables/useToast'
import {
  getWorktreeRootDir,
  setWorktreeRootDir,
  getSetupScript,
  setSetupScript,
  getBareSetupScript,
  setBareSetupScript,
  getWorktreeTimeout,
  setWorktreeTimeout,
  getDefaultBaseBranch,
  setDefaultBaseBranch,
} from '@/api/domains/settings'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

/** worktree 创建超时默认值（秒） */
const DEFAULT_TIMEOUT_SECONDS = 60

// ── 本地状态（乐观更新：先更新 UI，失败时回滚）──
const worktreeRootDir = ref('')
const setupScript = ref('')
const bareSetupScript = ref('')
const timeout = ref(DEFAULT_TIMEOUT_SECONDS)
const defaultBaseBranch = ref('origin/main')

// ── 初始值快照（用于失败回滚）──
let prevWorktreeRootDir = ''
let prevSetupScript = ''
let prevBareSetupScript = ''
let prevTimeout = DEFAULT_TIMEOUT_SECONDS
let prevDefaultBaseBranch = 'origin/main'

// ── 加载初始配置 ──
onMounted(async () => {
  try {
    const [rootDirRes, scriptRes, bareScriptRes, timeoutRes, baseBranchRes] = await Promise.allSettled([
      getWorktreeRootDir(),
      getSetupScript(),
      getBareSetupScript(),
      getWorktreeTimeout(),
      getDefaultBaseBranch(),
    ])

    if (rootDirRes.status === 'fulfilled') {
      worktreeRootDir.value = rootDirRes.value.dir
      prevWorktreeRootDir = rootDirRes.value.dir
    }
    if (scriptRes.status === 'fulfilled') {
      setupScript.value = scriptRes.value.script
      prevSetupScript = scriptRes.value.script
    }
    if (bareScriptRes.status === 'fulfilled') {
      bareSetupScript.value = bareScriptRes.value.script
      prevBareSetupScript = bareScriptRes.value.script
    }
    if (timeoutRes.status === 'fulfilled') {
      timeout.value = timeoutRes.value.timeout
      prevTimeout = timeoutRes.value.timeout
    }
    if (baseBranchRes.status === 'fulfilled') {
      defaultBaseBranch.value = baseBranchRes.value.baseBranch
      prevDefaultBaseBranch = baseBranchRes.value.baseBranch
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
})

// ── 保存 handlers（乐观更新 + 失败回滚）──

async function onSaveWorktreeRootDir() {
  if (worktreeRootDir.value === prevWorktreeRootDir) return
  const prev = prevWorktreeRootDir
  prevWorktreeRootDir = worktreeRootDir.value
  try {
    await setWorktreeRootDir(worktreeRootDir.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (_e) {
    worktreeRootDir.value = prev
    prevWorktreeRootDir = prev
    toastError(t('settings.worktree.saveFailed'))
  }
}

async function onSaveSetupScript() {
  if (setupScript.value === prevSetupScript) return
  const prev = prevSetupScript
  prevSetupScript = setupScript.value
  try {
    await setSetupScript(setupScript.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (_e) {
    setupScript.value = prev
    prevSetupScript = prev
    toastError(t('settings.worktree.saveFailed'))
  }
}

async function onSaveBareSetupScript() {
  if (bareSetupScript.value === prevBareSetupScript) return
  const prev = prevBareSetupScript
  prevBareSetupScript = bareSetupScript.value
  try {
    await setBareSetupScript(bareSetupScript.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (_e) {
    bareSetupScript.value = prev
    prevBareSetupScript = prev
    toastError(t('settings.worktree.saveFailed'))
  }
}

async function onSaveTimeout() {
  if (timeout.value === prevTimeout) return
  const prev = prevTimeout
  prevTimeout = timeout.value
  try {
    await setWorktreeTimeout(timeout.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (_e) {
    timeout.value = prev
    prevTimeout = prev
    toastError(t('settings.worktree.saveFailed'))
  }
}

async function onSaveDefaultBaseBranch() {
  if (defaultBaseBranch.value === prevDefaultBaseBranch) return
  const prev = prevDefaultBaseBranch
  prevDefaultBaseBranch = defaultBaseBranch.value
  try {
    await setDefaultBaseBranch(defaultBaseBranch.value)
    toastInfo(t('settings.worktree.saved'))
  } catch (_e) {
    defaultBaseBranch.value = prev
    prevDefaultBaseBranch = prev
    toastError(t('settings.worktree.saveFailed'))
  }
}

// ── 浏览按钮（placeholder：后续可接入 Electron dialog）──
function onBrowseWorktreeRootDir() {
  // TODO: 接入 Electron dialog.showOpenDialog
  toastInfo('浏览功能待实现')
}
</script>
