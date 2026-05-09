import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ToolPermission, ThemeMode } from '@xyz-agent/shared'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<ThemeMode>('light')
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

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
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
    theme, locale, defaultModel, currentView, focusMode,
    splitMode, overviewVisible, drawerOpen, drawerSide,
    toolPermissions, setToolPermission, resetToolPermissions,
    toggleTheme, setView, toggleFocus,
    toggleSplit, toggleOverview, openDrawer, closeDrawer,
  }
}, { persist: { key: 'xyz-settings', pick: ['theme', 'locale', 'defaultModel', 'toolPermissions'] } })
