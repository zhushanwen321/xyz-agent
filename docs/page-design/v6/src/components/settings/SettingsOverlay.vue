<script setup lang="ts">
import { settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'
import { providers, extensions } from '@/mock/sessions'
import SettingsNavItem from './SettingsNavItem.vue'
import ProviderPage from './ProviderPage.vue'
import ExtensionPage from './ExtensionPage.vue'
import ResourcesPage from './ResourcesPage.vue'
import SystemPromptPage from './SystemPromptPage.vue'
import PlaceholderPage from './PlaceholderPage.vue'

/** SettingsOverlay：fixed inset-0 z-modal bg-bg 全屏覆盖。
 * 左 nav w-220 bg-sunken + 右 content flex-1 bg-bg（内容列 max-w-720 mx-0 左对齐）。*/

interface NavDef {
  key: SettingsPage
  label: string
  icon: string
  count?: number
}

const ic = (p: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`

const NAV: NavDef[] = [
  { key: 'provider', label: '供应商', count: providers.length, icon: ic('<rect x="2" y="3" width="20" height="6" rx="2"/><rect x="2" y="15" width="20" height="6" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>') },
  { key: 'skill', label: '技能', icon: ic('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>') },
  { key: 'resources', label: '资源', icon: ic('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>') },
  { key: 'extension', label: '扩展', count: extensions.length, icon: ic('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>') },
  { key: 'system-prompt', label: '系统提示词', icon: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>') },
  { key: 'terminal', label: '终端', icon: ic('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>') },
  { key: 'preset', label: '预设', icon: ic('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>') },
  { key: 'worktree', label: '工作区', icon: ic('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>') },
  { key: 'update', label: '更新', icon: ic('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>') },
  { key: 'system', label: '系统', icon: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>') },
]

function select(key: SettingsPage) {
  settingsPage.value = key
}
</script>

<template>
  <div class="fso">
    <!-- 左 nav -->
    <nav class="fs-nav">
      <div class="nav-brand">
        <span class="brand-label">设置</span>
      </div>
      <div class="nav-list">
        <SettingsNavItem
          v-for="item in NAV"
          :key="item.key"
          :label="item.label"
          :icon="item.icon"
          :count="item.count"
          :active="settingsPage === item.key"
          @click="select(item.key)"
        />
      </div>
    </nav>

    <!-- 右 content -->
    <div class="fs-content">
      <div class="content-col-inner">
        <ProviderPage v-if="settingsPage === 'provider'" />
        <ExtensionPage v-else-if="settingsPage === 'extension'" />
        <ResourcesPage v-else-if="settingsPage === 'resources'" />
        <SystemPromptPage v-else-if="settingsPage === 'system-prompt'" />
        <PlaceholderPage v-else :page="settingsPage" />
      </div>
    </div>

    <!-- 右上角 X 关闭 -->
    <button class="xbtn" title="关闭设置（Esc）" @click="closeSettings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
</template>

<style scoped>
.fso {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--bg);
  display: flex;
}

/* 左 nav */
.fs-nav {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-sunken);
  display: flex;
  flex-direction: column;
  padding: var(--space-4) var(--space-3);
  gap: var(--space-1);
}
.nav-brand {
  height: 40px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-3);
  margin-bottom: var(--space-2);
}
.brand-label {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--neutral-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 右 content */
.fs-content {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  overflow-y: auto;
}
.content-col-inner {
  max-width: var(--content-max-w);
  margin-left: 0;
  margin-right: auto;
  padding: var(--space-8) var(--space-6);
}

/* 右上角 X */
.xbtn {
  position: fixed;
  top: var(--space-3);
  right: var(--space-4);
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  z-index: var(--z-modal);
  transition: all var(--duration-fast) var(--ease);
}
.xbtn svg {
  width: 18px;
  height: 18px;
}
.xbtn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
</style>
