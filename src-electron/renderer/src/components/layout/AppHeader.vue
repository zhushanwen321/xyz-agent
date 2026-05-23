<template>
  <header class="flex items-center h-header px-4 bg-surface border-b border-border shrink-0 gap-2 z-20">
    <Button variant="ghost" size="icon" class="rounded-sm text-muted hover:text-accent" @click="$emit('toggle-sidebar')" title="Sidebar (Cmd+B)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:16px;height:16px">
        <path d="M2 4h12M2 8h12M2 12h12"/>
      </svg>
    </Button>
    <div class="font-display text-base font-bold leading-tight -tracking-[0.01em]">xyz<span class="text-accent">-agent</span></div>
    <div class="flex-1"></div>
    <Button variant="ghost" size="icon" class="relative rounded-sm text-muted hover:text-accent" @click="openInspector" :title="t('header.notifications')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 01-3.46 0"/>
      </svg>
      <span v-if="focusedNotifs.done > 0 || focusedNotifs.alert > 0" class="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-sm text-[9px] font-bold text-white flex items-center justify-center bg-danger border-2 border-surface">
        {{ focusedNotifs.done + focusedNotifs.alert }}
      </span>
    </Button>
    <span class="w-px h-6 bg-border mx-1"></span>
    <Button variant="ghost" size="icon" class="rounded-sm text-muted hover:text-accent" @click="settingsStore.togglePanelGrid()" :title="t('header.overview') + ' (Cmd+J)'">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
        <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
      </svg>
    </Button>
    <Button variant="ghost" size="icon" class="rounded-sm text-muted hover:text-accent" @click="cycleViewMode" :title="viewModeTitle">
      <svg v-if="panelStore.panelCount <= 1" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
        <rect x="1" y="1" width="4" height="14" rx="1"/><rect x="6" y="1" width="9" height="14" rx="1"/>
      </svg>
      <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
        <rect x="1" y="1" width="6" height="14" rx="1"/><rect x="9" y="1" width="6" height="14" rx="1"/>
      </svg>
    </Button>
    <span class="w-px h-6 bg-border mx-1"></span>
    <Button variant="ghost" size="icon" :class="['rounded-sm text-muted hover:text-accent', { 'text-accent': settingsStore.currentView === 'settings' }]" @click="openSettings" :title="t('header.settings') + ' (Cmd+)'">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008.58 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 8.58a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    </Button>
    <Button variant="ghost" size="icon" class="rounded-sm text-muted hover:text-accent" @click="toggleTheme" :title="t('header.toggleTheme')">
      <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
        <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
        <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
      </svg>
    </Button>
  </header>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { useSettingsStore } from '../../stores/settings'
import { usePanelStore } from '../../stores/panel'
import { useChatStore } from '../../stores/chat'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const settingsStore = useSettingsStore()
const panelStore = usePanelStore()
const chatStore = useChatStore()
const isDark = ref(document.documentElement.getAttribute('data-theme') === 'dark')
defineEmits<{ 'toggle-sidebar': [] }>()

// 从 focused pane 的 session 分区读取通知计数
const focusedNotifs = computed(() => {
  const sid = panelStore.focusedPanel?.sessionId
  if (!sid) return { done: 0, alert: 0 }
  const s = chatStore.getSessionState(sid)
  return { done: s.doneCount, alert: s.alertCount }
})
function cycleViewMode() {
  if (panelStore.panelCount <= 1) {
    panelStore.splitPanel(panelStore.focusedPanelId, 'horizontal')
  } else {
    panelStore.mergeToSingle()
  }
}

const viewModeTitle = computed(() => {
  if (panelStore.panelCount > 1) return t('header.viewStandard')
  return t('header.split')
})

function openInspector() {
  settingsStore.openInspector('right')
}

function openSettings() {
  settingsStore.setView(settingsStore.currentView === 'settings' ? 'chat' : 'settings')
}

function toggleTheme() {
  settingsStore.toggleTheme()
  isDark.value = settingsStore.theme === 'dark' ||
    (settingsStore.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}
</script>

