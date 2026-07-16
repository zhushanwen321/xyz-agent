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

    <!-- 卡 3：快捷键（可重录 + 重置） -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.system.shortcutTitle') }}</h3>
        <p class="mt-0.5 text-[10px] text-subtle">{{ t('settings.system.shortcutRecordingHint') }}</p>
      </div>
      <div class="border-t border-border">
        <div
          v-for="cmd in shortcutRows"
          :key="cmd.id"
          class="flex items-center justify-between border-b border-border px-4 py-2.5 last:border-b-0"
        >
          <span class="text-[12px] text-fg">{{ t(`settings.command.${cmd.id}`) }}</span>
          <div class="flex items-center gap-2">
            <!-- 录态：闪烁提示 -->
            <span
              v-if="recordingId === cmd.id"
              class="animate-pulse text-[11px] text-accent"
            >{{ t('settings.system.shortcutRecording') }}</span>
            <!-- 正常态：显示快捷键 kbd -->
            <kbd
              v-else-if="cmd.shortcut"
              class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle"
            >{{ cmd.shortcut }}</kbd>
            <span v-else class="text-[11px] text-subtle">-</span>
            <!-- 重录按钮 -->
            <Button
              variant="ghost"
              class="h-auto rounded-sm px-1.5 py-0.5 text-[10px] text-accent hover:bg-transparent hover:underline"
              :class="{ 'text-danger': recordingId === cmd.id }"
              @click="recordingId === cmd.id ? cancelRecording() : startRecording(cmd.id)"
            >{{ recordingId === cmd.id ? t('settings.providerEdit.cancel') : t('settings.system.shortcutReRecord') }}</Button>
            <!-- 重置按钮（仅自定义覆盖时显示） -->
            <Button
              v-if="commandStore.shortcutOverrides[cmd.id]"
              variant="ghost"
              class="h-auto rounded-sm px-1.5 py-0.5 text-[10px] text-subtle hover:bg-transparent hover:text-danger"
              @click="resetShortcut(cmd.id)"
            >{{ t('settings.system.shortcutReset') }}</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
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

// ── 快捷键重录 ──

const commandStore = useCommandStore()
const { appCommands } = storeToRefs(commandStore)

/** 默认快捷键 key（与 useAppCommands 注册时一致，用于重置时恢复） */
const DEFAULT_KEYS: Record<string, string> = {
  'new-session': 'n',
  'toggle-sidebar': 'b',
}

/** 当前正在录制的命令 id（null = 未录制） */
const recordingId = ref<string | null>(null)

/** 平台检测（显示修饰键符号用） */
const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

/** 将存储的 key（如 'n' / 'mod+shift+j'）转为显示用的修饰键符号 */
function formatShortcut(key: string): string {
  const parts = key.split('+')
  const result: string[] = []
  for (const p of parts) {
    if (p === 'mod') result.push(isMac ? '⌘' : 'Ctrl')
    else if (p === 'shift') result.push(isMac ? '⇧' : 'Shift')
    else if (p === 'alt') result.push(isMac ? '⌥' : 'Alt')
    else if (p === 'enter') result.push('↵')
    else if (p === 'escape') result.push('Esc')
    else if (p === ' ') result.push('Space')
    else result.push(p.toUpperCase())
  }
  return isMac ? result.join('') : result.join('+')
}

/** 构建快捷键显示文本：有 override 用 override，否则用默认修饰键 */
function displayShortcut(cmdId: string): string {
  const override = commandStore.shortcutOverrides[cmdId]
  if (override) return formatShortcut(override)
  const defaultKey = DEFAULT_KEYS[cmdId]
  if (!defaultKey) return ''
  return isMac ? `⌘${defaultKey.toUpperCase()}` : `Ctrl+${defaultKey.toUpperCase()}`
}

/** 可重录的命令行（过滤 go-overview，它无默认快捷键） */
const shortcutRows = computed(() =>
  appCommands.value
    .filter((c) => c.id in DEFAULT_KEYS)
    .map((c) => ({ id: c.id, shortcut: displayShortcut(c.id) })),
)

/** 开始录制：注册全局 keydown 监听，捕获下一次按键 */
function startRecording(cmdId: string): void {
  recordingId.value = cmdId
  window.addEventListener('keydown', onRecordKeydown, true)
}

/** 取消录制 */
function cancelRecording(): void {
  recordingId.value = null
  window.removeEventListener('keydown', onRecordKeydown, true)
}

/** 录态 keydown：解析修饰键 + 主键，持久化到 commandStore */
function onRecordKeydown(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()

  // Escape 取消录制
  if (e.key === 'Escape') {
    cancelRecording()
    return
  }

  // 需要至少一个非修饰键
  const mainKey = e.key.toLowerCase()
  if (['meta', 'control', 'shift', 'alt'].includes(mainKey)) return

  // 组合键字符串
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(mainKey)
  const combo = parts.join('+')

  const cmdId = recordingId.value!
  commandStore.setShortcutOverride(cmdId, combo)

  // 同步更新 appCommands 中对应命令的 shortcut 显示文本
  const idx = appCommands.value.findIndex((c) => c.id === cmdId)
  if (idx !== -1) {
    const updated = [...appCommands.value]
    updated[idx] = { ...updated[idx], shortcut: formatShortcut(combo) }
    commandStore.registerApp(updated)
  }

  cancelRecording()
}

/** 重置为默认快捷键 */
function resetShortcut(cmdId: string): void {
  commandStore.setShortcutOverride(cmdId, null)

  // 恢复 appCommands 中的默认显示
  const idx = appCommands.value.findIndex((c) => c.id === cmdId)
  if (idx !== -1) {
    const defaultKey = DEFAULT_KEYS[cmdId]
    const updated = [...appCommands.value]
    updated[idx] = {
      ...updated[idx],
      shortcut: isMac ? `⌘${defaultKey.toUpperCase()}` : `Ctrl+${defaultKey.toUpperCase()}`,
    }
    commandStore.registerApp(updated)
  }
}

/** 组件卸载时清理录制监听器 */
onBeforeUnmount(() => {
  if (recordingId.value) cancelRecording()
})

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
