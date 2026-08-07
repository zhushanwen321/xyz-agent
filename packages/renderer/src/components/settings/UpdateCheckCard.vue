<!--
  Settings · System 页 · 版本检查卡片。

  自包含组件：内部调 useAppUpdate（单例 state），与侧边栏 UpdateButton 共享同一份 state，
  天然联动（任一入口检测/下载/安装，另一处实时反映）。

  状态机分支（state.state）：
  - idle         检查按钮
  - checking     loading + disabled
  - available    新版本号 + 下载并安装
  - downloading  进度百分比
  - downloaded   重启安装（弹确认 Dialog）
  - replacing    替换中
  - restarting   即将重启
  - error        错误信息 + 重试
  - unsupported  前往下载（备用页）
-->
<template>
  <div class="rounded-md border border-border bg-bg">
    <div class="px-4 pb-3 pt-3">
      <h3 class="text-[13px] font-medium text-neutral-fg">{{ t('settings.system.versionTitle') }}</h3>
      <p class="mt-0.5 text-[10px] text-neutral-dim">{{ t('settings.system.versionDesc') }}</p>
    </div>
    <div class="flex items-center justify-between border-t border-border px-4 py-3">
      <!-- 状态文案（左） -->
      <div class="flex min-w-0 items-center gap-1.5">
        <!-- idle / checking：当前版本 -->
        <template v-if="state.state === 'idle' || state.state === 'checking'">
          <Label class="text-[12px] text-neutral-fg">{{ t('settings.system.currentVersion') }}</Label>
          <span class="text-[12px] text-neutral-mid">v{{ appVersion }}</span>
        </template>
        <!-- available：发现新版本 -->
        <span
          v-else-if="state.state === 'available'"
          class="text-[12px] text-accent"
          data-testid="settings-update-new-version"
        >{{ t('settings.system.newVersionAvailable', { version: state.latestRelease?.version }) }}</span>
        <!-- downloading / verifying：进度 -->
        <span
          v-else-if="state.state === 'downloading' || state.state === 'verifying'"
          class="inline-flex items-center gap-1 text-[12px] text-neutral-mid"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.downloading', { percent: state.percent }) }}
        </span>
        <!-- downloaded：已下载 -->
        <span
          v-else-if="state.state === 'downloaded'"
          class="inline-flex items-center gap-1 text-[12px] text-success"
        >
          <CheckCircle2 class="size-4" />
          {{ t('settings.system.downloaded') }}
        </span>
        <!-- replacing -->
        <span
          v-else-if="state.state === 'replacing'"
          class="inline-flex items-center gap-1 text-[12px] text-neutral-mid"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.replacing') }}
        </span>
        <!-- restarting -->
        <span
          v-else-if="state.state === 'restarting'"
          class="inline-flex items-center gap-1 text-[12px] text-success"
        >
          <CheckCircle2 class="size-4" />
          {{ t('settings.system.restarting') }}
        </span>
        <!-- error：错误信息 -->
        <span
          v-else-if="state.state === 'error'"
          class="inline-flex items-center gap-1 text-[12px] text-danger"
          data-testid="settings-update-error"
        >
          <AlertCircle class="size-4 shrink-0" />
          <span class="truncate">{{ state.errorMessage }}</span>
        </span>
        <!-- unsupported -->
        <span
          v-else-if="state.state === 'unsupported'"
          class="text-[12px] text-neutral-mid"
        >{{ t('settings.system.unsupported') }}</span>
      </div>

      <!-- 操作按钮（右） -->
      <div class="flex shrink-0 items-center gap-2">
        <!-- idle：检查更新 -->
        <Button
          v-if="state.state === 'idle'"
          variant="default"
          size="sm"
          data-testid="settings-update-check"
          @click="onCheck"
        >
          <RefreshCw class="size-4" />
          {{ t('settings.system.checkUpdate') }}
        </Button>
        <!-- checking：loading disabled -->
        <Button
          v-else-if="state.state === 'checking'"
          variant="default"
          size="sm"
          disabled
          data-testid="settings-update-check"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.checking') }}
        </Button>
        <!-- available：下载并安装 -->
        <Button
          v-else-if="state.state === 'available'"
          variant="default"
          size="sm"
          data-testid="settings-update-download"
          @click="onDownload"
        >
          <Download class="size-4" />
          {{ t('settings.system.downloadAndInstall') }}
        </Button>
        <!-- downloaded：重启安装（弹确认 Dialog） -->
        <Button
          v-else-if="state.state === 'downloaded'"
          variant="default"
          size="sm"
          data-testid="settings-update-install"
          @click="onInstallClick"
        >{{ t('settings.system.restartInstall') }}</Button>
        <!-- error：重试 -->
        <Button
          v-else-if="state.state === 'error'"
          variant="secondary"
          size="sm"
          data-testid="settings-update-retry"
          @click="onRetry"
        >
          <RefreshCw class="size-4" />
          {{ t('settings.system.retry') }}
        </Button>
        <!-- unsupported：前往下载 -->
        <Button
          v-else-if="state.state === 'unsupported'"
          variant="default"
          size="sm"
          data-testid="settings-update-unsupported"
          @click="onOpenFallbackUrl"
        >{{ t('settings.system.goToDownload') }}</Button>
      </div>
    </div>

    <!-- 确认重启安装 Dialog -->
    <Dialog :open="showConfirmDialog" @update:open="showConfirmDialog = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t('settings.system.restartInstall') }}</DialogTitle>
          <DialogDescription>
            {{ t('settings.system.confirmInstall', { version: state.latestRelease?.version }) }}
          </DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" @click="onLater">{{ t('settings.system.installLater') }}</Button>
          <Button
            variant="default"
            size="sm"
            data-testid="settings-update-confirm-install"
            @click="onConfirmInstall"
          >{{ t('settings.system.installNow') }}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Download, CheckCircle2, AlertCircle, Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppUpdate } from '@/composables/features/settings/useAppUpdate'

const { t } = useI18n()
const { state, checkForUpdate, performDownload, performInstall, openFallbackUrl } = useAppUpdate()

/** xyz-agent 版本号（vite define 注入，全局声明见 env.d.ts） */
const appVersion = __APP_VERSION__

/** 确认重启安装 Dialog 开关 */
const showConfirmDialog = ref(false)

/** idle：强制检测新版 */
function onCheck(): void {
  void checkForUpdate(true)
}

/** available：触发下载阶段 */
function onDownload(): void {
  void performDownload()
}

/** downloaded：打开确认 Dialog（不直接执行 install，避免误点中断会话） */
function onInstallClick(): void {
  showConfirmDialog.value = true
}

/** 确认安装：关闭 Dialog 后执行 install（替换 + 重启） */
async function onConfirmInstall(): Promise<void> {
  showConfirmDialog.value = false
  await performInstall()
}

/** 稍后：仅关闭 Dialog */
function onLater(): void {
  showConfirmDialog.value = false
}

/** error 态重试：强制重新检测 */
function onRetry(): void {
  void checkForUpdate(true)
}

/** unsupported：打开备用下载页 */
function onOpenFallbackUrl(): void {
  void openFallbackUrl()
}
</script>
