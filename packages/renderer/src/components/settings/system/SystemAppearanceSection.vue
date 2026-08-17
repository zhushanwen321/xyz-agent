<template>
  <div class="flex flex-col gap-4">
    <!-- 语言与外观 -->
    <GroupCard :title="t('settings.system.languageAppearance')">
      <div class="px-2.5 pt-1 pb-2">
        <SettingRow :label="t('settings.system.language')" :desc="t('settings.system.languageDesc')">
          <Select
            :model-value="system.locale"
            @update:model-value="emit('update', { locale: $event as SystemSettings['locale'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">{{ t('settings.system.langZhCN') }}</SelectItem>
              <SelectItem value="en-US">{{ t('settings.system.langEnUS') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.system.appearance')" :desc="t('settings.system.appearanceDesc')">
          <Select
            :model-value="system.theme"
            @update:model-value="emit('update', { theme: $event as SystemSettings['theme'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{{ t('settings.system.themeLight') }}</SelectItem>
              <SelectItem value="dark">{{ t('settings.system.themeDark') }}</SelectItem>
              <SelectItem value="system">{{ t('settings.system.themeSystem') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.system.fontSize')" :desc="t('settings.system.fontSizeDesc')">
          <Select
            :model-value="system.fontSize ?? 'medium'"
            @update:model-value="emit('update', { fontSize: $event as SystemSettings['fontSize'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.system.fontSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.system.fontMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.system.fontLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.system.completionSound')" :desc="t('settings.system.completionSoundDesc')">
          <Switch
            data-testid="setting-completion-sound"
            :model-value="system.completionSound ?? true"
            @update:model-value="emit('update', { completionSound: $event === true })"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 配色主题（太极 · 即时切换） -->
    <GroupCard :title="t('settings.system.themePresetTitle')">
      <p class="mt-1.5 mb-2 mx-2.5 text-xs text-neutral-mid">{{ t('settings.system.themePresetHint') }}</p>
      <div class="flex flex-col gap-0.5 px-2.5 pb-2.5">
        <Button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          variant="ghost"
          type="button"
          class="theme-row flex items-center justify-between rounded-md px-3 py-2.5 text-neutral-fg cursor-pointer transition-colors hover:bg-surface-hover"
          :class="th.label === currentTheme.label ? 'bg-surface text-accent hover:bg-surface' : ''"
          :aria-pressed="th.label === currentTheme.label"
          @click="applyTaijiTheme(th)"
        >
          <span class="text-sm font-medium">{{ th.label }}</span>
          <span class="flex gap-1">
            <span
              v-for="(c, i) in th.swatch"
              :key="i"
              class="size-4 rounded-full border border-border"
              :style="{ background: c }"
            />
          </span>
        </Button>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@xyz-agent/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import type { SystemSettings } from '@xyz-agent/core'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'

const props = defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()

// ── 太极主题（即时切换：写 store + 同步 DOM）──
const currentTheme = computed<TaijiTheme>(() => resolveTaijiTheme(props.system))
function applyTaijiTheme(th: TaijiTheme): void {
  emit('update', { theme: th.theme, themePreset: th.preset })
}
</script>
