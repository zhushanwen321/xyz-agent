<template>
  <header class="app-header">
    <div class="header-logo">xyz<span class="header-logo-accent">-agent</span></div>
    <div class="header-spacer"></div>
    <div class="notif-group">
      <button class="notif-btn notif-btn--done" :title="t('header.done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="2 6 5 9 10 3"/></svg>
        Done
        <span class="notif-dot notif-dot--done">3</span>
      </button>
      <button class="notif-btn notif-btn--alert" :title="t('header.alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        Alert
        <span class="notif-dot notif-dot--alert">1</span>
      </button>
    </div>
    <span class="h-divider"></span>
    <div class="header-actions">
      <button
        :class="['view-btn', { active: !settingsStore.focusMode }]"
        @click="settingsStore.setView('chat')"
        :title="t('header.viewStandard')"
      ><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg></button>
      <button
        :class="['view-btn', { active: settingsStore.focusMode }]"
        @click="settingsStore.toggleFocus()"
        :title="t('header.viewFocus')"
      ><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h3M10 3h3M13 3v3M13 10v3M10 13H13M3 13h3M3 10V13M3 3v3"/></svg></button>
      <span class="header-divider"></span>
      <button class="header-btn" @click="openSettings" :title="t('header.settings')"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg></button>
      <button class="header-btn" @click="toggleTheme" :title="t('header.toggleTheme')"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 1 0-11z"/><path d="M8 1.5v11" fill="currentColor"/></svg></button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const settingsStore = useSettingsStore()
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('xyz-agent-theme', next)
}

async function openSettings() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_settings_window')
  } catch {
    settingsStore.setView('settings')
  }
}
</script>

<style scoped>
.app-header {
  display: flex; align-items: center; height: var(--header-h);
  padding: 0 16px; background: var(--surface);
  border-bottom: 1px solid var(--border);
  gap: 8px; flex-shrink: 0; z-index: 20;
}
.header-logo { font-weight: 700; font-size: 16px; font-family: var(--font-display); }
.header-logo-accent { color: var(--accent); }
.header-spacer { flex: 1; }
.header-actions { display: flex; gap: 4px; align-items: center; }
.view-btn, .header-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: var(--radius-sm);
  border: 1px solid transparent; background: transparent;
  color: var(--muted); cursor: pointer; transition: all 0.2s;
}
.view-btn:hover, .header-btn:hover { background: var(--accent-light); color: var(--accent); }
.view-btn.active { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }
.header-divider { width: 1px; height: 24px; background: var(--border); margin: 0 4px; }
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
