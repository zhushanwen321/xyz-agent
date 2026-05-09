<template>
  <header class="header">
    <div class="header__logo">xyz<span>-agent</span></div>
    <div class="header__spacer"></div>
    <div class="notif-group">
      <Button variant="ghost" class="notif-btn notif-btn--done" :title="t('header.done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="2 6 5 9 10 3"/></svg>
        已完成
        <span class="notif-dot notif-dot--done">3</span>
      </Button>
      <Button variant="ghost" class="notif-btn notif-btn--alert" :title="t('header.alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        请求回应
        <span class="notif-dot notif-dot--alert">1</span>
      </Button>
    </div>
    <span class="h-divider"></span>
    <div class="header__actions">
      <Button variant="ghost" size="icon" class="h-btn" @click="settingsStore.toggleOverview()" title="窗口总览 (Cmd+J)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
        </svg>
      </Button>
      <Button variant="ghost" size="icon" :class="['h-btn', { active: !settingsStore.focusMode && !settingsStore.splitMode }]" @click="setView('standard')" title="标准 (Cmd+1)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="4" height="14" rx="1"/><rect x="6" y="1" width="9" height="14" rx="1"/>
        </svg>
      </Button>
      <Button variant="ghost" size="icon" :class="['h-btn', { active: settingsStore.splitMode }]" @click="setView('split')" title="分屏 (Cmd+2)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="6" height="14" rx="1"/><rect x="9" y="1" width="6" height="14" rx="1"/>
        </svg>
      </Button>
      <Button variant="ghost" size="icon" :class="['h-btn', { active: settingsStore.focusMode }]" @click="setView('focus')" title="专注 (Cmd+3)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="14" height="14" rx="1"/>
        </svg>
      </Button>
      <span class="h-divider"></span>
      <Button variant="ghost" size="icon" :class="['h-btn', { active: settingsStore.currentView === 'settings' }]" @click="openSettings" title="设置 (Cmd+,)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
          <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008.58 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 8.58a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </Button>
      <Button variant="ghost" size="icon" class="h-btn" @click="toggleTheme" title="切换主题">
        <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
          <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
        </svg>
      </Button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '../../design-system'
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const settingsStore = useSettingsStore()
const isDark = ref(document.documentElement.getAttribute('data-theme') === 'dark')
function setView(mode: string) {
  switch (mode) {
    case 'standard':
      settingsStore.focusMode = false
      settingsStore.splitMode = false
      settingsStore.currentView = 'chat'
      break
    case 'split':
      settingsStore.focusMode = false
      settingsStore.splitMode = !settingsStore.splitMode
      settingsStore.currentView = 'chat'
      break
    case 'focus':
      settingsStore.splitMode = false
      settingsStore.focusMode = !settingsStore.focusMode
      settingsStore.currentView = 'chat'
      break
  }
}

function openSettings() {
  settingsStore.setView(settingsStore.currentView === 'settings' ? 'chat' : 'settings')
}

function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('xyz-agent-theme', next)
  isDark.value = next === 'dark'
}
</script>

<style scoped>
/* Only overrides not covered by global CSS */
.header__actions { display: flex; gap: 4px; align-items: center; }
.h-btn { border-radius: var(--radius-sm) !important; color: var(--muted) !important; }
</style>
