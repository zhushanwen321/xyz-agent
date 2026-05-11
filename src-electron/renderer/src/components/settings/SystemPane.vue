<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { Select, Button } from '../../design-system'
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

interface PaletteOption {
  id: ThemePreset
  label: string
  swatch: string
  group: 'muted' | 'colorful'
}

const palettes: PaletteOption[] = [
  { id: 'warm-teal', label: 'Warm Teal', swatch: 'oklch(55% 0.08 195)', group: 'muted' },
  { id: 'cold-teal', label: 'Cold Teal', swatch: 'oklch(62% 0.10 190)', group: 'muted' },
  { id: 'neutral', label: 'Neutral', swatch: 'oklch(40% 0 0)', group: 'muted' },
  { id: 'sharp', label: 'Sharp', swatch: 'oklch(10% 0 0)', group: 'muted' },
  { id: 'warm-neutral', label: 'Warm Neutral', swatch: 'oklch(45% 0.04 80)', group: 'muted' },
  { id: 'terracotta', label: 'Terracotta', swatch: 'oklch(64% 0.13 28)', group: 'colorful' },
  { id: 'rose', label: 'Rose', swatch: 'oklch(65% 0.14 350)', group: 'colorful' },
  { id: 'amber', label: 'Amber', swatch: 'oklch(67% 0.15 65)', group: 'colorful' },
  { id: 'blue', label: 'Blue', swatch: 'oklch(62% 0.15 250)', group: 'colorful' },
  { id: 'violet', label: 'Violet', swatch: 'oklch(62% 0.15 280)', group: 'colorful' },
]

const mutedPalettes = palettes.filter(p => p.group === 'muted')
const colorfulPalettes = palettes.filter(p => p.group === 'colorful')

const currentPalette = computed(() => settingsStore.themePreset)

function selectPalette(id: ThemePreset) {
  settingsStore.setThemePreset(id)
}
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
    <div class="palette-section">
      <div class="palette-section__label">配色主题</div>
      <div class="palette-group">
        <div class="palette-group__title">Muted</div>
        <div class="palette-group__list">
          <Button
            v-for="p in mutedPalettes"
            :key="p.id"
            variant="ghost"
            class="palette-swatch"
            :class="{ active: currentPalette === p.id }"
            @click="selectPalette(p.id)"
          >
            <span class="palette-swatch__dot" :style="{ background: p.swatch }" />
            <span class="palette-swatch__name">{{ p.label }}</span>
          </Button>
        </div>
      </div>
      <div class="palette-group">
        <div class="palette-group__title">Colorful</div>
        <div class="palette-group__list">
          <Button
            v-for="p in colorfulPalettes"
            :key="p.id"
            variant="ghost"
            class="palette-swatch"
            :class="{ active: currentPalette === p.id }"
            @click="selectPalette(p.id)"
          >
            <span class="palette-swatch__dot" :style="{ background: p.swatch }" />
            <span class="palette-swatch__name">{{ p.label }}</span>
          </Button>
        </div>
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

.palette-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.palette-section__label {
  font-size: 13px;
  color: var(--muted);
}

.palette-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.palette-group__title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.palette-group__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.palette-swatch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  font-family: var(--font-body);
  color: var(--fg);
}

.palette-swatch:hover {
  border-color: var(--muted);
  background: var(--accent-light);
}

.palette-swatch.active {
  border-color: var(--accent);
  background: var(--accent-light);
  box-shadow: 0 0 0 1px var(--accent);
}

.palette-swatch__dot {
  @apply flex-shrink-0 rounded-full;
  width: 16px;
  height: 16px;
}

.palette-swatch__name {
  font-size: 12px;
  white-space: nowrap;
}
</style>
