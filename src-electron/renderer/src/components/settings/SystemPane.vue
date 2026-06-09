<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { Select, Button, Toggle } from '../../design-system'
import { ALL_PI_TOOLS } from '../../lib/message-layout'
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

function toggleStandaloneTool(tool: string, checked: boolean) {
  const tools = [...settingsStore.standaloneTools]
  if (checked) {
    if (!tools.includes(tool)) tools.push(tool)
  } else {
    const idx = tools.indexOf(tool)
    if (idx >= 0) tools.splice(idx, 1)
  }
  settingsStore.standaloneTools = tools
}
</script>

<template>
  <div class="max-w-[860px]">
    <!-- Section: 语言与外观 -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center py-2.5 px-4 bg-[var(--section-bg)] min-h-[42px]">
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

    <!-- Section: 聊天显示 -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center py-2.5 px-4 bg-[var(--section-bg)] min-h-[42px]">
        <span class="text-[13px] font-semibold">聊天显示</span>
      </div>
      <div>
        <div class="flex items-center justify-between gap-4 py-2.5 px-4 border-b border-[var(--divider)]">
          <div>
            <span class="text-xs font-medium">展开思考过程</span>
            <span class="text-[10px] text-muted ml-1.5">自动展开 Thinking 内容</span>
          </div>
          <Toggle :checked="settingsStore.autoExpandThinking" @update:checked="settingsStore.autoExpandThinking = $event" />
        </div>
        <div class="flex items-center justify-between gap-4 py-2.5 px-4">
          <div>
            <span class="text-xs font-medium">展开工具调用</span>
            <span class="text-[10px] text-muted ml-1.5">自动展开 ToolCall 输入/输出</span>
          </div>
          <Toggle :checked="settingsStore.autoExpandToolCalls" @update:checked="settingsStore.autoExpandToolCalls = $event" />
        </div>
        <div class="flex items-center justify-between gap-4 py-2.5 px-4">
          <div>
            <span class="text-xs font-medium">折叠 Agent 操作过程</span>
            <span class="text-[10px] text-muted ml-1.5">将 Thinking/ToolCall 合并为摘要标签</span>
          </div>
          <Toggle :checked="settingsStore.compactStreaming" @update:checked="settingsStore.compactStreaming = $event" />
        </div>
        <!-- Standalone tools: only visible when compactStreaming is on -->
        <template v-if="settingsStore.compactStreaming">
          <div class="flex items-center justify-between gap-4 py-2.5 px-4">
            <div>
              <span class="text-xs font-medium">独立展示工具</span>
              <span class="text-[10px] text-muted ml-1.5">在 AgentRunBlock 中作为独立卡片展示的工具</span>
            </div>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-2">
            <div v-for="tool in ALL_PI_TOOLS" :key="tool" class="flex items-center gap-1.5 cursor-pointer text-[11px] text-muted">
              <Toggle
                :checked="settingsStore.standaloneTools.includes(tool)"
                @update:checked="toggleStandaloneTool(tool, $event)"
              />
              <span class="font-mono">{{ tool }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Section: 配色主题 -->
    <div class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center py-2.5 px-4 bg-[var(--section-bg)] min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.colorTheme') }}</span>
      </div>
      <div class="py-3 px-4">
        <div class="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted mb-2">Muted</div>
        <div class="flex flex-wrap gap-2 mb-3">
          <Button
            v-for="p in mutedPalettes"
            :key="p.id"
            variant="ghost"
            class="flex items-center gap-2 py-1.5 px-3 rounded-sm border cursor-pointer transition-all duration-150 font-body text-fg"
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
            class="flex items-center gap-2 py-1.5 px-3 rounded-sm border cursor-pointer transition-all duration-150 font-body text-fg"
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
