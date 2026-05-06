import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<'light' | 'dark'>('light')
  const locale = ref<string>('zh-CN')
  const defaultModel = ref('anthropic/claude-sonnet')
  const currentView = ref<'chat' | 'settings'>('chat')
  const focusMode = ref(false)

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
  }
  function setView(v: 'chat' | 'settings') { currentView.value = v }
  function toggleFocus() { focusMode.value = !focusMode.value }

  return {
    theme, locale, defaultModel, currentView, focusMode,
    toggleTheme, setView, toggleFocus,
  }
}, { persist: { key: 'xyz-settings', pick: ['theme', 'locale', 'defaultModel'] } })
