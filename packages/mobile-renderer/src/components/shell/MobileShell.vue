<script setup lang="ts">
/**
 * MobileShell —— 移动端主布局容器（spec P4 §3.1 + D3）。
 *
 * h-[100dvh] flex flex-col 三段式：
 *   - Header（session 标题占位，s3/s4 填真实 session 名 + 菜单）
 *   - Content（flex-1 overflow-hidden，KeepAlive 包裹三 tab content 占位）
 *   - BottomTabBar（三 tab 导航）
 *
 * activeTab 本地 ref，默认 'sessions'。tab 切换不卸载（KeepAlive，spec §3.3）。
 *
 * s2 版本：三 tab content 是占位文本（sessions/files/settings），s3/s4 替换为真实组件。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BottomTabBar from './BottomTabBar.vue'
import type { MobileTab } from './types'

const { t } = useI18n()
const activeTab = ref<MobileTab>('sessions')
</script>

<template>
  <div class="mobile-shell flex flex-col bg-bg text-fg" style="height: 100dvh">
    <!-- Header（session 标题占位，s3 接 session 名 + 菜单） -->
    <header
      class="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-3"
      style="padding-top: calc(env(safe-area-inset-top) + 12px)"
      data-testid="mobile-header"
    >
      <span class="text-sm font-semibold">{{ t('mobile.shell.title') }}</span>
    </header>

    <!-- Content（flex-1 overflow-hidden，KeepAlive 三 tab 占位） -->
    <main class="mobile-content flex-1 overflow-hidden" data-testid="mobile-content">
      <KeepAlive>
        <section v-if="activeTab === 'sessions'" key="sessions" data-testid="mobile-tab-content-sessions" class="h-full p-4 text-sm text-muted">
          sessions
        </section>
        <section v-else-if="activeTab === 'files'" key="files" data-testid="mobile-tab-content-files" class="h-full p-4 text-sm text-muted">
          files
        </section>
        <section v-else key="settings" data-testid="mobile-tab-content-settings" class="h-full p-4 text-sm text-muted">
          settings
        </section>
      </KeepAlive>
    </main>

    <!-- BottomTabBar -->
    <BottomTabBar v-model:active-tab="activeTab" />
  </div>
</template>
