import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<'light' | 'dark'>('light')
  const locale = ref<string>('zh-CN')
  const defaultModel = ref('anthropic/claude-sonnet')
  const currentView = ref<'chat' | 'settings'>('chat')
  const focusMode = ref(false)
  const splitMode = ref(false)
  const overviewVisible = ref(false)
  const drawerOpen = ref(false)
  const drawerSide = ref<'left' | 'right'>('right')

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
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
    toggleTheme, setView, toggleFocus,
    toggleSplit, toggleOverview, openDrawer, closeDrawer,
  }
}, { persist: { key: 'xyz-settings', pick: ['theme', 'locale', 'defaultModel'] } })
