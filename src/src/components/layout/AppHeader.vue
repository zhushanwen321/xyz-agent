<template>
  <header class="app-header">
    <div class="header-logo">xyz<span class="header-logo-accent">-agent</span></div>
    <div class="header-spacer"></div>
    <div class="notif-group">
      <button class="notif-btn notif-btn--done" :title="t('header.done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="2 6 5 9 10 3"/></svg>
        已完成
        <span class="notif-dot notif-dot--done">3</span>
      </button>
      <button class="notif-btn notif-btn--alert" :title="t('header.alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        请求回应
        <span class="notif-dot notif-dot--alert">1</span>
      </button>
    </div>
    <span class="h-divider"></span>
    <div class="header-actions">
      <button class="h-btn" @click="settingsStore.toggleOverview()" title="窗口总览 (Cmd+J)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
        </svg>
      </button>
      <button :class="['h-btn', { active: !settingsStore.focusMode && !settingsStore.splitMode }]" @click="setView('standard')" title="标准 (Cmd+1)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="4" height="14" rx="1"/><rect x="6" y="1" width="9" height="14" rx="1"/>
        </svg>
      </button>
      <button :class="['h-btn', { active: settingsStore.splitMode }]" @click="setView('split')" title="分屏 (Cmd+2)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="6" height="14" rx="1"/><rect x="9" y="1" width="6" height="14" rx="1"/>
        </svg>
      </button>
      <button :class="['h-btn', { active: settingsStore.focusMode }]" @click="setView('focus')" title="专注 (Cmd+3)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <rect x="1" y="1" width="14" height="14" rx="1"/>
        </svg>
      </button>
      <span class="h-divider"></span>
      <button :class="['h-btn', { active: settingsStore.currentView === 'settings' }]" @click="openSettings" title="设置 (Cmd+,)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" style="width:16px;height:16px">
          <circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.77 1.77M11.18 11.18l1.77 1.77M3.05 12.95l1.77-1.77M11.18 4.82l1.77-1.77"/>
        </svg>
      </button>
      <button class="h-btn" @click="toggleTheme" title="切换主题">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px">
          <path d="M14 9.5A6.5 6.5 0 016.5 2 6.5 6.5 0 108 14.5a6.47 6.47 0 006-5z"/>
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const settingsStore = useSettingsStore()
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
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('xyz-agent-theme', next)
}
</script>

<style scoped>
.app-header {
  display: flex; align-items: center; height: var(--header-h);
  padding: 0 16px; background: var(--surface);
  border-bottom: 1px solid var(--border);
  gap: 8px; flex-shrink: 0; z-index: 20;
}
.header-logo { font-family: var(--font-display); font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.header-logo-accent { color: var(--accent); }
.header-spacer { flex: 1; }
.header-actions { display: flex; gap: 4px; align-items: center; }
.h-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: transparent;
  color: var(--muted); cursor: pointer; transition: all 0.2s;
}
.h-btn:hover { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }
.h-btn.active { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }
.h-divider { width: 1px; height: 24px; background: var(--border); margin: 0 4px; }
.notif-group { display: flex; gap: 6px; align-items: center; }
.notif-btn { position: relative; display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border: 1px solid var(--border); border-radius: 100px; background: transparent; color: var(--muted); font-size: 12px; font-family: var(--font-body); cursor: pointer; transition: all 0.2s; white-space: nowrap; }
.notif-btn:hover { background: var(--bg); color: var(--fg); border-color: var(--muted); }
.notif-btn--done:hover { background: var(--success-light); color: var(--success); border-color: var(--success); }
.notif-btn--alert:hover { background: var(--danger-light); color: var(--danger); border-color: var(--danger); }
.notif-dot { position: absolute; top: -4px; right: -4px; width: 18px; height: 18px; border-radius: 50%; font-size: 10px; font-weight: 700; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid var(--surface); }
.notif-dot--done { background: var(--success); }
.notif-dot--alert { background: var(--danger); animation: pulse-dot 2s infinite; }
@keyframes pulse-dot { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }
.notif-btn svg { width: 14px; height: 14px; }
</style>
