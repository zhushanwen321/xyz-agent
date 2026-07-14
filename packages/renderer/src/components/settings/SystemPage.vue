<template>
  <!--
    Settings · System 菜单页（handoff-system.md · 模式 A+B · 全枚举开关）。
    两块 Card：语言与外观 / 配色主题。聊天显示整块从 draft 移除（handoff §11a 决议）。
  -->
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- 卡 1：语言与外观 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.system.languageAppearance') }}</h3>
      </div>
      <div class="border-t border-border">
        <!-- 语言 -->
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.system.language') }}</Label>
          <Select
            :model-value="system.locale"
            @update:model-value="emit('update', { locale: $event as SystemSettings['locale'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">{{ t('settings.system.langZhCN') }}</SelectItem>
              <SelectItem value="en-US">{{ t('settings.system.langEnUS') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <!-- 外观模式 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.system.appearance') }}</Label>
          <Select
            :model-value="system.theme"
            @update:model-value="emit('update', { theme: $event as SystemSettings['theme'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{{ t('settings.system.themeLight') }}</SelectItem>
              <SelectItem value="dark">{{ t('settings.system.themeDark') }}</SelectItem>
              <SelectItem value="system">{{ t('settings.system.themeSystem') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <!-- 字体大小 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.system.fontSize') }}</Label>
          <Select
            :model-value="system.fontSize ?? 'medium'"
            @update:model-value="emit('update', { fontSize: $event as SystemSettings['fontSize'] })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.system.fontSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.system.fontMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.system.fontLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>

    <!-- 卡 2：配色主题 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.system.themePresetTitle') }}</h3>
      </div>
      <div class="border-t border-border px-4 py-3">
        <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">{{ t('settings.system.presetMuted') }}</p>
        <div class="mb-3 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            v-for="sw in mutedSwatches"
            :key="sw.id"
            class="h-auto gap-2 rounded-sm border px-3 py-1.5 text-[12px] transition-colors hover:bg-transparent"
            :class="system.themePreset === sw.id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
              : 'border-border bg-bg hover:bg-[var(--accent-soft)]'"
            @click="emit('update', { themePreset: sw.id })"
          >
            <span class="size-4 rounded-full" :style="{ background: sw.color }" />
            <span class="text-fg">{{ sw.label }}</span>
          </Button>
        </div>
        <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">{{ t('settings.system.presetColorful') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            v-for="sw in colorfulSwatches"
            :key="sw.id"
            class="h-auto gap-2 rounded-sm border px-3 py-1.5 text-[12px] transition-colors hover:bg-transparent"
            :class="system.themePreset === sw.id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
              : 'border-border bg-bg hover:bg-[var(--accent-soft)]'"
            @click="emit('update', { themePreset: sw.id })"
          >
            <span class="size-4 rounded-full" :style="{ background: sw.color }" />
            <span class="text-fg">{{ sw.label }}</span>
          </Button>
        </div>
      </div>
    </div>

    <!-- 卡 3：快捷键（只读展示当前已注册的应用命令及其快捷键） -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.system.shortcutTitle') }}</h3>
      </div>
      <div class="border-t border-border">
        <div
          v-for="cmd in shortcutCommands"
          :key="cmd.id"
          class="flex items-center justify-between border-b border-border px-4 py-2.5 last:border-b-0"
        >
          <span class="text-[12px] text-fg">{{ t(`settings.command.${cmd.id}`) }}</span>
          <kbd
            v-if="cmd.shortcut"
            class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle"
          >{{ cmd.shortcut }}</kbd>
          <span v-else class="text-[11px] text-subtle">-</span>
        </div>
      </div>
      <!-- TODO(W6): 重录功能（keydown 捕获 + setShortcutOverride + 实时生效）待实现。
           当前只读展示；监听器（Sidebar keymap）硬编码按 key 匹配，改快捷键需联动监听器，风险较高，降级处理。 -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCommandStore } from '@/stores/command'
import type { SystemSettings } from '@/stores/settings'

defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()

/**
 * 快捷键只读展示：从 commandStore.appCommands 读当前已注册的应用命令及其快捷键。
 * useAppCommands.registerAppCommands 注册 new-session(⌘N) / toggle-sidebar(⌘B) / go-overview。
 * 重录功能待实现（见 template TODO）。
 */
const commandStore = useCommandStore()
const { appCommands } = storeToRefs(commandStore)
const SHORTCUT_LABELS: Record<string, true> = {
  'new-session': true,
  'toggle-sidebar': true,
  'go-overview': true,
}
const shortcutCommands = computed(() =>
  appCommands.value.filter((c) => c.id in SHORTCUT_LABELS),
)

const mutedSwatches = [
  { id: 'warm-teal', label: 'Warm Teal', color: 'oklch(55% 0.08 195)' },
  { id: 'cold-teal', label: 'Cold Teal', color: 'oklch(62% 0.10 190)' },
  { id: 'neutral', label: 'Neutral', color: 'oklch(40% 0 0)' },
  { id: 'sharp', label: 'Sharp', color: 'oklch(10% 0 0)' },
  { id: 'warm-neutral', label: 'Warm Neutral', color: 'oklch(45% 0.04 80)' },
]

const colorfulSwatches = [
  { id: 'cold-blue', label: 'Cold Blue', color: '#4f8ef7' },
  { id: 'terracotta', label: 'Terracotta', color: 'oklch(64% 0.13 28)' },
  { id: 'rose', label: 'Rose', color: 'oklch(65% 0.14 350)' },
  { id: 'amber', label: 'Amber', color: 'oklch(67% 0.15 65)' },
  { id: 'blue', label: 'Blue', color: 'oklch(62% 0.15 250)' },
  { id: 'violet', label: 'Violet', color: 'oklch(62% 0.15 280)' },
]
</script>
