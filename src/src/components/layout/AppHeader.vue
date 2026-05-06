<template>
  <header class="app-header">
    <div class="header-logo">xyz<span class="header-logo-accent">-agent</span></div>
    <div class="header-spacer"></div>
    <div class="header-actions">
      <button
        :class="['view-btn', { active: !settingsStore.focusMode }]"
        @click="settingsStore.setView('chat')"
        :title="t('header.viewStandard')"
      >☰</button>
      <button
        :class="['view-btn', { active: settingsStore.focusMode }]"
        @click="settingsStore.toggleFocus()"
        :title="t('header.viewFocus')"
      >◻</button>
      <span class="header-divider"></span>
      <button class="header-btn" @click="settingsStore.setView('settings')" :title="t('header.settings')">⚙</button>
      <button class="header-btn" @click="toggleTheme" :title="t('header.toggleTheme')">🌙</button>
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
</script>

<style scoped>
.app-header {
  display: flex; align-items: center; height: var(--header-height);
  padding: 0 16px; background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  gap: 8px; flex-shrink: 0;
}
.header-logo { font-weight: 700; font-size: 16px; font-family: var(--font-display); }
.header-logo-accent { color: var(--color-accent); }
.header-spacer { flex: 1; }
.header-actions { display: flex; gap: 4px; align-items: center; }
.view-btn, .header-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: var(--radius-sm);
  border: 1px solid transparent; background: transparent;
  color: var(--color-text-muted); cursor: pointer; transition: all 0.2s;
}
.view-btn:hover, .header-btn:hover { background: var(--color-accent-light); color: var(--color-accent); }
.view-btn.active { background: var(--color-accent-light); color: var(--color-accent); border-color: var(--color-accent); }
.header-divider { width: 1px; height: 24px; background: var(--color-border); margin: 0 4px; }
</style>
