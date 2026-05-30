import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ThemeMode, ThemePreset } from '@xyz-agent/shared'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<ThemeMode>('light')
  const themePreset = ref<ThemePreset>('neutral')
  const locale = ref<string>('zh-CN')
  const defaultModel = ref('')
  const currentView = ref<'chat' | 'settings'>('chat')
  const panelGridVisible = ref(false)
  const inspectorOpen = ref(false)
  const inspectorSide = ref<'left' | 'right'>('right')

  // Chat display settings
  const autoExpandThinking = ref(true)
  const autoExpandToolCalls = ref(true)

  // 旧值迁移: 'warm' → 'warm-teal', 'claude' → 'terracotta'
  function migratePalette(p: string): ThemePreset {
    if (p === 'warm') return 'warm-teal'
    if (p === 'claude') return 'terracotta'
    return p as ThemePreset
  }

  function applyTheme() {
    const migrated = migratePalette(themePreset.value)
    if (migrated !== themePreset.value) themePreset.value = migrated
    const el = document.documentElement
    el.setAttribute('data-theme', theme.value === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme.value)
    el.setAttribute('data-palette', migrated)
    localStorage.setItem('xyz-agent-theme', theme.value)
    localStorage.setItem('xyz-agent-palette', migrated)
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme()
  }
  function setThemePreset(preset: ThemePreset) {
    themePreset.value = preset
    document.documentElement.setAttribute('data-palette', preset)
    localStorage.setItem('xyz-agent-palette', preset)
  }
  function setView(v: 'chat' | 'settings') { currentView.value = v }
  function togglePanelGrid() { panelGridVisible.value = !panelGridVisible.value }
  function openInspector(side: 'left' | 'right') { inspectorOpen.value = true; inspectorSide.value = side }
  function closeInspector() { inspectorOpen.value = false }

  return {
    theme, themePreset, locale, defaultModel, currentView,
    panelGridVisible, inspectorOpen, inspectorSide,
    autoExpandThinking, autoExpandToolCalls,
    toggleTheme, applyTheme, setThemePreset, setView,
    togglePanelGrid, openInspector, closeInspector,
  }
}, { persist: { key: 'xyz-settings', pick: ['theme', 'themePreset', 'locale', 'defaultModel', 'autoExpandThinking', 'autoExpandToolCalls'] } })
