import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ToolPermission, ThemeMode, ThemePreset } from '@xyz-agent/shared'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<ThemeMode>('light')
  const themePreset = ref<ThemePreset>('warm')
  const locale = ref<string>('zh-CN')
  const defaultModel = ref('')
  const currentView = ref<'chat' | 'settings'>('chat')
  const focusMode = ref(false)
  const splitMode = ref(false)
  const overviewVisible = ref(false)
  const drawerOpen = ref(false)
  const drawerSide = ref<'left' | 'right'>('right')

  const toolPermissions = ref<Record<string, ToolPermission>>({
    read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
    bash: 'ask', edit: 'ask', write: 'ask',
  })

  function applyTheme() {
    const el = document.documentElement
    el.setAttribute('data-theme', theme.value === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme.value)
    el.setAttribute('data-palette', themePreset.value)
    localStorage.setItem('xyz-agent-theme', theme.value)
    localStorage.setItem('xyz-agent-palette', themePreset.value)
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme()
  }
  function setThemePreset(preset: ThemePreset) {
    themePreset.value = preset
    applyTheme()
  }
  function setToolPermission(tool: string, perm: ToolPermission) {
    toolPermissions.value[tool] = perm
  }
  function resetToolPermissions() {
    toolPermissions.value = {
      read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
      bash: 'ask', edit: 'ask', write: 'ask',
    }
  }
  function setView(v: 'chat' | 'settings') { currentView.value = v }
  function toggleFocus() { focusMode.value = !focusMode.value }
  function toggleSplit() { splitMode.value = !splitMode.value }
  function toggleOverview() { overviewVisible.value = !overviewVisible.value }
  function openDrawer(side: 'left' | 'right') { drawerOpen.value = true; drawerSide.value = side }
  function closeDrawer() { drawerOpen.value = false }

  return {
    theme, themePreset, locale, defaultModel, currentView, focusMode,
    splitMode, overviewVisible, drawerOpen, drawerSide,
    toolPermissions, setToolPermission, resetToolPermissions,
    toggleTheme, applyTheme, setThemePreset, setView, toggleFocus,
    toggleSplit, toggleOverview, openDrawer, closeDrawer,
  }
}, { persist: { key: 'xyz-settings', pick: ['theme', 'themePreset', 'locale', 'defaultModel', 'toolPermissions'] } })
