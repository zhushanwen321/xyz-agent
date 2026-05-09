<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { Select } from '../../design-system'
import { setLocale, getLocale, type Locale } from '../../i18n'
import type { ThemePreset } from '@xyz-agent/shared'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const languageOptions = [
  { label: '简体中文', value: 'zh-CN' },
  { label: 'English (US)', value: 'en-US' },
]

const currentLocale = computed({
  get: () => getLocale(),
  set: (val: string) => {
    const locale = val as Locale
    setLocale(locale)
    settingsStore.locale = locale
  },
})

const themeModeOptions = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' },
]

const currentThemeMode = computed({
  get: () => settingsStore.theme,
  set: (val: string) => {
    settingsStore.theme = val as 'light' | 'dark' | 'system'
    settingsStore.applyTheme()
  },
})

const paletteOptions = [
  { label: '暖沙', value: 'warm' },
  { label: 'Claude', value: 'claude' },
]

const currentPalette = computed({
  get: () => settingsStore.themePreset,
  set: (val: string) => {
    settingsStore.setThemePreset(val as ThemePreset)
  },
})
</script>

<template>
  <div class="system-pane">
    <div class="system-pane__row">
      <div class="system-pane__label">{{ t('settings.language') }}</div>
      <div class="system-pane__control">
        <Select
          v-model="currentLocale"
          :options="languageOptions"
          class="system-pane__select"
        />
      </div>
    </div>
    <div class="system-pane__row">
      <div class="system-pane__label">外观模式</div>
      <div class="system-pane__control">
        <Select
          v-model="currentThemeMode"
          :options="themeModeOptions"
          class="system-pane__select"
        />
      </div>
    </div>
    <div class="system-pane__row">
      <div class="system-pane__label">配色主题</div>
      <div class="system-pane__control">
        <Select
          v-model="currentPalette"
          :options="paletteOptions"
          class="system-pane__select"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.system-pane {
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.system-pane__row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.system-pane__label {
  font-size: 13px;
  color: var(--muted);
  flex-shrink: 0;
}

.system-pane__control {
  flex: 1;
  max-width: 200px;
}
</style>
