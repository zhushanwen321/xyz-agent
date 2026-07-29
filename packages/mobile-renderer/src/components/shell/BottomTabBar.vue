<script setup lang="ts">
/**
 * BottomTabBar —— 移动端底部三 tab 导航（spec P4 §3.3 + D3）。
 *
 * Sessions / Files / Settings 三 tab，active tab 高亮（text-accent）。
 * h-56px + pb-[env(safe-area-inset-bottom)] 处理 iOS home indicator。
 * emit update:activeTab 给 MobileShell。
 *
 * s2 版本：tab 点击切换 activeTab（DOM 断言 AC4）。s3/s4 填充真实 tab content。
 */
import { MessageSquare, Folder, Settings } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { MobileTab } from './types'

defineProps<{ activeTab: MobileTab }>()
const emit = defineEmits<{ 'update:activeTab': [tab: MobileTab] }>()

const { t } = useI18n()

const tabs: ReadonlyArray<{ id: MobileTab; label: string; icon: typeof MessageSquare; testId: string }> = [
  { id: 'sessions', label: t('mobile.shell.tabSessions'), icon: MessageSquare, testId: 'mobile-tab-sessions' },
  { id: 'files', label: t('mobile.shell.tabFiles'), icon: Folder, testId: 'mobile-tab-files' },
  { id: 'settings', label: t('mobile.shell.tabSettings'), icon: Settings, testId: 'mobile-tab-settings' },
]

function select(tab: MobileTab): void {
  emit('update:activeTab', tab)
}
</script>

<template>
  <nav
    class="mobile-tabbar flex shrink-0 items-stretch justify-around border-t border-border bg-surface"
    style="height: 56px; padding-bottom: env(safe-area-inset-bottom)"
    role="tablist"
  >
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="activeTab === tab.id"
      :data-testid="tab.testId"
      class="mobile-tab flex flex-1 flex-col items-center justify-center gap-[2px] border-0 bg-transparent"
      :class="activeTab === tab.id ? 'text-accent' : 'text-subtle'"
      @click="select(tab.id)"
    >
      <component :is="tab.icon" :size="20" :stroke-width="1.8" />
      <span class="text-[9px] font-medium">{{ tab.label }}</span>
    </button>
  </nav>
</template>
