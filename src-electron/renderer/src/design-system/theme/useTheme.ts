import { computed } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import type { ThemePreset } from '@xyz-agent/shared'

export function useTheme() {
  const settings = useSettingsStore()

  const currentTheme = computed(() => settings.theme)
  const currentPalette = computed(() => settings.themePreset)

  function toggleTheme() {
    settings.toggleTheme()
  }

  function setPalette(palette: ThemePreset) {
    settings.setThemePreset(palette)
  }

  return { currentTheme, currentPalette, toggleTheme, setPalette }
}
