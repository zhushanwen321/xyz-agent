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

const themeModeOptions = computed(() => [
  { label: t('settings.themeLight'), value: 'light' },
  { label: t('settings.themeDark'), value: 'dark' },
  { label: t('settings.themeSystem'), value: 'system' },
])

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
  <div class="max-w-[860px]">
    <!-- Section: 语言与外观 -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center py-[9px] px-4 bg-[var(--section-bg)] min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.languageAndAppearance') }}</span>
      </div>
      <div>
        <div class="flex items-center gap-4 py-2.5 px-4 border-b border-[var(--divider)]">
          <span class="text-xs font-medium min-w-[76px]">{{ t('settings.language') }}</span>
          <div class="flex-1 max-w-[200px]">
            <Select v-model="currentLocale" :options="languageOptions" />
          </div>
        </div>
        <div class="flex items-center gap-4 py-2.5 px-4">
          <span class="text-xs font-medium min-w-[76px]">{{ t('settings.appearanceMode') }}</span>
          <div class="flex-1 max-w-[200px]">
            <Select v-model="currentThemeMode" :options="themeModeOptions" />
          </div>
        </div>
      </div>
    </div>

    <!-- Section: 配色主题 -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center py-[9px] px-4 bg-[var(--section-bg)] min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.colorTheme') }}</span>
      </div>
      <div class="py-3 px-4">
        <div class="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted mb-2">Muted</div>
        <div class="flex flex-wrap gap-2 mb-3">
          <Button
            v-for="p in mutedPalettes"
            :key="p.id"
            variant="ghost"
            class="flex items-center gap-2 py-[6px] px-3 rounded-sm border cursor-pointer transition-all duration-150 font-body text-fg"
            :class="currentPalette === p.id ? 'border-[var(--accent)] bg-[var(--accent-light)] ring-1 ring-[var(--accent)]' : 'border-border bg-surface hover:border-muted hover:bg-[var(--accent-light)]'"
            @click="selectPalette(p.id)"
          >
            <span class="shrink-0 rounded-full w-4 h-4" :style="{ background: p.swatch }" />
            <span class="text-xs whitespace-nowrap">{{ p.label }}</span>
          </Button>
        </div>

        <div class="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted mb-2">Colorful</div>
        <div class="flex flex-wrap gap-2">
          <Button
            v-for="p in colorfulPalettes"
            :key="p.id"
            variant="ghost"
            class="flex items-center gap-2 py-[6px] px-3 rounded-sm border cursor-pointer transition-all duration-150 font-body text-fg"
            :class="currentPalette === p.id ? 'border-[var(--accent)] bg-[var(--accent-light)] ring-1 ring-[var(--accent)]' : 'border-border bg-surface hover:border-muted hover:bg-[var(--accent-light)]'"
            @click="selectPalette(p.id)"
          >
            <span class="shrink-0 rounded-full w-4 h-4" :style="{ background: p.swatch }" />
            <span class="text-xs whitespace-nowrap">{{ p.label }}</span>
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
