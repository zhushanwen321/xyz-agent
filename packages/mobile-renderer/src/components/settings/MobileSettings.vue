<script setup lang="ts">
/**
 * MobileSettings —— 移动端设置简化版（spec P4 §十.4 + slice C2 + C11）。
 *
 * P4 只做（完整 settings providers/models/skills 留桌面端，C11）：
 *  - 连接信息：getActiveProfile() host/token 显示 + getDeviceName() 只读
 *  - theme 切换：读 useSettingsStore().system.theme，调 setSystem({theme}) 切换 dark/light
 *    （store applySystemToDom 写 document.documentElement data-theme）
 *  - 断开按钮：deactivateRemote() 清 connection-mode=local + location.reload()
 *    （与 renderer/mobile Landing.vue onDisconnectRemote 对齐）。
 *    reload 必要性：App.vue 连接门控 watch useConnection().state（ws-client 来源），
 *    不读 localStorage；单 deactivateRemote 不改 state，App 仍渲染 MobileShell、
 *    WS 仍占用。reload 后 isRemoteMode()===false，App onMounted 走「无存档」分支
 *    渲染 MobileConnectScreen（reload 自然断开 WS）。
 *
 * deviceName 只读不编辑（slice C2 定 P4 简化，setDeviceName 留 P9）。
 * theme 只 dark/light toggle（system 模式留桌面端，P4 移动简化）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { getActiveProfile, getDeviceName, deactivateRemote } from '@/lib/remote/connection-config'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const toast = useToast()

const profile = computed(() => getActiveProfile())
const deviceName = computed(() => getDeviceName())
const theme = computed(() => settingsStore.system.theme)

/** theme toggle：dark ↔ light（system 归到 dark，P4 移动简化） */
async function toggleTheme(): Promise<void> {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  // setSystem 乐观更新 + applySystemToDom（写 data-theme），失败回滚（store 已实现）。
  // catch 不静默：toast 反馈让用户感知失败（与其他组件错误反馈一致）。
  try {
    await settingsStore.setSystem({ theme: next })
  } catch {
    toast.error(t('mobile.settings.themeToggleFailed'))
  }
}

/** 断开远程：清 connection-mode=local（profile 保留，可重新粘贴重连）+ reload 切回连接页。
 *  reload 必要性见文件头注释（App 连接门控只 watch ws-client state，不读 localStorage）。 */
function onDisconnect(): void {
  deactivateRemote()
  location.reload()
}
</script>

<template>
  <div class="mobile-settings flex h-full flex-col" data-testid="mobile-settings">
    <!-- header -->
    <div class="flex shrink-0 items-center border-b border-border px-4 py-3">
      <span class="text-sm font-semibold">{{ t('mobile.settings.title') }}</span>
    </div>

    <!-- 连接信息区 -->
    <div class="flex-1 overflow-y-auto">
      <section
        v-if="profile"
        class="border-b border-border px-4 py-3"
        data-testid="mobile-settings-connection"
      >
        <div class="mb-2 text-xs font-semibold uppercase text-subtle">
          {{ t('mobile.settings.connectionInfo') }}
        </div>
        <div class="mb-2 flex flex-col gap-1 text-sm">
          <div class="flex flex-col gap-0.5">
            <span class="text-xs text-subtle">{{ t('mobile.settings.host') }}</span>
            <span class="break-all text-fg" data-testid="mobile-settings-host">{{ profile.url }}</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-xs text-subtle">{{ t('mobile.settings.token') }}</span>
            <span class="break-all text-muted" data-testid="mobile-settings-token">
              {{ profile.token ? profile.token.slice(0, 8) + '…' : '—' }}
            </span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-xs text-subtle">{{ t('mobile.settings.deviceName') }}</span>
            <span class="text-fg" data-testid="mobile-settings-device-name">{{ deviceName }}</span>
          </div>
        </div>
        <button
          type="button"
          class="mt-2 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-medium text-danger"
          data-testid="mobile-settings-disconnect"
          @click="onDisconnect"
        >
          {{ t('mobile.settings.disconnect') }}
        </button>
      </section>
      <!-- 未连接 -->
      <section
        v-else
        class="border-b border-border px-4 py-3 text-sm text-muted"
        data-testid="mobile-settings-not-connected"
      >
        {{ t('mobile.settings.notConnected') }}
      </section>

      <!-- theme 区 -->
      <section class="flex items-center justify-between px-4 py-3" data-testid="mobile-settings-theme">
        <span class="text-sm text-fg">{{ t('mobile.settings.theme') }}</span>
        <button
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white"
          data-testid="mobile-settings-theme-toggle"
          @click="toggleTheme"
        >
          {{ theme === 'dark' ? t('mobile.settings.themeLight') : t('mobile.settings.themeDark') }}
        </button>
      </section>
    </div>
  </div>
</template>
