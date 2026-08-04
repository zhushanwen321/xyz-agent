<template>
  <!--
    Settings · System 菜单页（v6 §6.4 + §5.8）。
    GroupCard 分组：语言与外观 / 配色主题 / 提示音 / 快捷键。
    太极主题即时切换（点击即生效，走 store.setSystem 同步 DOM）。
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.system') }}</h1>
        <p class="desc">{{ t('settings.menu.systemDesc') }}</p>
      </div>
    </header>

    <!-- 语言与外观 -->
    <GroupCard title="语言与外观">
      <div class="sys-rows">
        <SettingRow label="语言" desc="界面显示语言与区域格式">
          <Select
            :model-value="system.locale"
            @update:model-value="emit('update', { locale: $event as SystemSettings['locale'] })"
          >
            <SelectTrigger class="sys-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">{{ t('settings.system.langZhCN') }}</SelectItem>
              <SelectItem value="en-US">{{ t('settings.system.langEnUS') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="外观模式" desc="亮色、暗色或跟随系统">
          <Select
            :model-value="system.theme"
            @update:model-value="emit('update', { theme: $event as SystemSettings['theme'] })"
          >
            <SelectTrigger class="sys-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{{ t('settings.system.themeLight') }}</SelectItem>
              <SelectItem value="dark">{{ t('settings.system.themeDark') }}</SelectItem>
              <SelectItem value="system">{{ t('settings.system.themeSystem') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="字体大小" desc="对话与界面正文的字体大小">
          <Select
            :model-value="system.fontSize ?? 'medium'"
            @update:model-value="emit('update', { fontSize: $event as SystemSettings['fontSize'] })"
          >
            <SelectTrigger class="sys-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.system.fontSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.system.fontMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.system.fontLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="后台完成提示音" desc="后台任务完成时播放提示音">
          <Switch
            data-testid="setting-completion-sound"
            :model-value="system.completionSound ?? true"
            @update:model-value="emit('update', { completionSound: $event === true })"
          />
        </SettingRow>
        <SettingRow label="会话自动重命名" desc="首轮对话后自动用主题给会话命名">
          <Switch
            data-testid="setting-auto-rename-session"
            :model-value="autoRenameEnabled"
            :disabled="togglingAutoRename"
            @update:model-value="onSaveAutoRename"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 配色主题（太极 · 即时切换） -->
    <GroupCard title="配色主题">
      <p class="theme-hint">太极配色 · 即时切换（点击即生效，无需保存）</p>
      <div class="theme-list">
        <button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          type="button"
          class="theme-row"
          :class="{ active: th.label === currentTheme.label }"
          :aria-pressed="th.label === currentTheme.label"
          @click="applyTaijiTheme(th)"
        >
          <span class="theme-name">{{ th.label }}</span>
          <span class="theme-swatches">
            <span
              v-for="(c, i) in th.swatch"
              :key="i"
              class="swatch"
              :style="{ background: c }"
            />
          </span>
        </button>
      </div>
    </GroupCard>

    <!-- 提示音 -->
    <GroupCard title="提示音">
      <div class="sys-rows">
        <SettingRow label="成功音" desc="任务成功完成时播放">
          <div class="sound-wrap">
            <Select
              :model-value="system.successSound || SOUND_DEFAULT"
              @update:model-value="onSuccessSoundChange"
            >
              <SelectTrigger class="sys-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="SOUND_DEFAULT">
                  {{ t('settings.system.soundDefault') }}
                  <template #action>
                    <SoundPreviewButton
                      :loading="previewingKey === 'success:default'"
                      :title="t('settings.system.soundPreview')"
                      :data-testid="`preview-success-default`"
                      @click="previewSound('success', getDefaultSound(currentPlatform, 'success'), 'default')"
                    />
                  </template>
                </SelectItem>
                <SelectItem v-for="s in soundList" :key="s.id" :value="s.id">
                  {{ s.name }}
                  <template #action>
                    <SoundPreviewButton
                      :loading="previewingKey === `success:${s.id}`"
                      :title="t('settings.system.soundPreview')"
                      :data-testid="`preview-success-${s.id}`"
                      @click="previewSound('success', s.id, s.id)"
                    />
                  </template>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="dense"
              class="preview-btn"
              :disabled="!!previewingKey"
              :aria-label="t('settings.system.soundPreview')"
              @click="previewSound('success', system.successSound || getDefaultSound(currentPlatform, 'success'), system.successSound || 'default')"
            >
              <Volume2 v-if="previewingKey !== 'success:default' && previewingKey !== `success:${system.successSound}`" class="size-3.5" />
              <Loader2 v-else class="size-3.5 animate-spin" />
              {{ previewingKey?.startsWith('success:') ? t('settings.system.soundPreviewing') : t('settings.system.soundPreview') }}
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="失败音" desc="任务失败时播放">
          <div class="sound-wrap">
            <Select
              :model-value="system.errorSound || SOUND_DEFAULT"
              @update:model-value="onErrorSoundChange"
            >
              <SelectTrigger class="sys-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="SOUND_DEFAULT">
                  {{ t('settings.system.soundDefault') }}
                  <template #action>
                    <SoundPreviewButton
                      :loading="previewingKey === 'error:default'"
                      :title="t('settings.system.soundPreview')"
                      :data-testid="`preview-error-default`"
                      @click="previewSound('error', getDefaultSound(currentPlatform, 'error'), 'default')"
                    />
                  </template>
                </SelectItem>
                <SelectItem v-for="s in soundList" :key="s.id" :value="s.id">
                  {{ s.name }}
                  <template #action>
                    <SoundPreviewButton
                      :loading="previewingKey === `error:${s.id}`"
                      :title="t('settings.system.soundPreview')"
                      :data-testid="`preview-error-${s.id}`"
                      @click="previewSound('error', s.id, s.id)"
                    />
                  </template>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="dense"
              class="preview-btn"
              :disabled="!!previewingKey"
              :aria-label="t('settings.system.soundPreview')"
              @click="previewSound('error', system.errorSound || getDefaultSound(currentPlatform, 'error'), system.errorSound || 'default')"
            >
              <Volume2 v-if="previewingKey !== 'error:default' && previewingKey !== `error:${system.errorSound}`" class="size-3.5" />
              <Loader2 v-else class="size-3.5 animate-spin" />
              {{ previewingKey?.startsWith('error:') ? t('settings.system.soundPreviewing') : t('settings.system.soundPreview') }}
            </Button>
          </div>
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 快捷键 -->
    <GroupCard title="快捷键">
      <p class="shortcut-hint">{{ t('settings.system.shortcutRecordingHint') }}</p>
      <div class="sys-rows">
        <div
          v-for="cmd in shortcutRows"
          :key="cmd.id"
          class="setting-row"
        >
          <div class="sr-left">
            <div class="sr-label">
              <span class="label">{{ t(`settings.command.${cmd.id}`) }}</span>
              <span v-if="recordingId === cmd.id" class="rec-hint">{{ t('settings.system.shortcutRecording') }}</span>
            </div>
          </div>
          <div class="sr-right">
            <kbd v-if="recordingId !== cmd.id && cmd.shortcut" class="kbd">{{ cmd.shortcut }}</kbd>
            <span v-else-if="recordingId !== cmd.id" class="text-[11px] text-neutral-dim">-</span>
            <Button
              variant="ghost"
              size="dense"
              class="rec-btn"
              :class="{ 'text-danger': recordingId === cmd.id }"
              @click="recordingId === cmd.id ? cancelRecording() : startRecording(cmd.id)"
            >{{ recordingId === cmd.id ? t('settings.providerEdit.cancel') : t('settings.system.shortcutReRecord') }}</Button>
            <Button
              v-if="commandStore.shortcutOverrides.value[cmd.id]"
              variant="ghost"
              size="dense"
              class="reset-btn"
              @click="resetShortcut(cmd.id)"
            >{{ t('settings.system.shortcutReset') }}</Button>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Volume2, Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { GroupCard, SoundPreviewButton } from '@xyz-agent/ui/features/settings'
import SettingRow from './SettingRow.vue'
import { useCommandStore } from '@/composables/features/useCommandStore'
import { listSystemSounds } from '@/lib/ipc'
import { playByName } from '@/composables/useCompletionSound'
import { getDefaultSound, detectPlatform } from '@/composables/sound-defaults'
import type { SystemSettings } from '@xyz-agent/core'
import { getAutoRenameEnabled, setAutoRenameEnabled } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'

interface SoundInfo { id: string; name: string }

const props = defineProps<{
  system: SystemSettings
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── 太极主题（即时切换：写 store + 同步 DOM）──
const currentTheme = computed<TaijiTheme>(() => resolveTaijiTheme(props.system))
function applyTaijiTheme(th: TaijiTheme): void {
  emit('update', { theme: th.theme, themePreset: th.preset })
}

// ── 系统提示音 ──
const soundList = ref<SoundInfo[]>([])
const currentPlatform = detectPlatform()
const SOUND_DEFAULT = '__default__'

function onSuccessSoundChange(value: unknown): void {
  const v = typeof value === 'string' ? value : ''
  emit('update', { successSound: v === SOUND_DEFAULT ? '' : v })
}
function onErrorSoundChange(value: unknown): void {
  const v = typeof value === 'string' ? value : ''
  emit('update', { errorSound: v === SOUND_DEFAULT ? '' : v })
}

const PREVIEW_LOADING_MS = 300
const previewingKey = ref<string | null>(null)

onMounted(async () => {
  try {
    const result = await listSystemSounds()
    if (result.sounds.length) soundList.value = result.sounds
  } catch (err) {
    console.error('[settings] listSystemSounds failed:', err)
  }
})

async function previewSound(kind: 'success' | 'error', name: string, trackId: string): Promise<void> {
  if (!name) return
  if (previewingKey.value) return
  const key = `${kind}:${trackId}`
  previewingKey.value = key
  try {
    await playByName(name)
  } finally {
    setTimeout(() => {
      if (previewingKey.value === key) previewingKey.value = null
    }, PREVIEW_LOADING_MS)
  }
}

// ── 快捷键重录 ──
const commandStore = useCommandStore()
const { appCommands } = commandStore

const DEFAULT_KEYS: Record<string, string> = {
  'new-session': 'n',
  'toggle-sidebar': 'b',
}

const recordingId = ref<string | null>(null)
const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

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

function displayShortcut(cmdId: string): string {
  const override = commandStore.shortcutOverrides.value[cmdId]
  if (override) return formatShortcut(override)
  const defaultKey = DEFAULT_KEYS[cmdId]
  if (!defaultKey) return ''
  return isMac ? `⌘${defaultKey.toUpperCase()}` : `Ctrl+${defaultKey.toUpperCase()}`
}

const shortcutRows = computed(() =>
  appCommands.value
    .filter((c) => c.id in DEFAULT_KEYS)
    .map((c) => ({ id: c.id, shortcut: displayShortcut(c.id) })),
)

function startRecording(cmdId: string): void {
  recordingId.value = cmdId
  window.addEventListener('keydown', onRecordKeydown, true)
}

function cancelRecording(): void {
  recordingId.value = null
  window.removeEventListener('keydown', onRecordKeydown, true)
}

function onRecordKeydown(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    cancelRecording()
    return
  }
  const mainKey = e.key.toLowerCase()
  if (['meta', 'control', 'shift', 'alt'].includes(mainKey)) return
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(mainKey)
  const combo = parts.join('+')

  const cmdId = recordingId.value!
  commandStore.setShortcutOverride(cmdId, combo)
  const idx = appCommands.value.findIndex((c) => c.id === cmdId)
  if (idx !== -1) {
    const updated = [...appCommands.value]
    updated[idx] = { ...updated[idx], shortcut: formatShortcut(combo) }
    commandStore.registerApp(updated)
  }
  cancelRecording()
}

function resetShortcut(cmdId: string): void {
  commandStore.setShortcutOverride(cmdId, null)
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

onBeforeUnmount(() => {
  if (recordingId.value) cancelRecording()
})

// ── 会话自动重命名 ──
const autoRenameEnabled = ref(true)
const togglingAutoRename = ref(false)

onMounted(async () => {
  try {
    const res = await getAutoRenameEnabled()
    autoRenameEnabled.value = res.enabled
  } catch (e) {
    console.warn('[SystemPage] failed to load auto-rename state:', e)
  }
})

async function onSaveAutoRename(enabled: boolean): Promise<void> {
  if (togglingAutoRename.value) return
  togglingAutoRename.value = true
  const prev = autoRenameEnabled.value
  autoRenameEnabled.value = enabled
  try {
    await setAutoRenameEnabled(enabled)
    toastInfo(t('settings.system.saved'))
  } catch (_e) {
    autoRenameEnabled.value = prev
    toastError(t('settings.system.saveFailed'))
  } finally {
    togglingAutoRename.value = false
  }
}
</script>

<style scoped>
.sys-rows {
  padding: 4px 10px 8px;
}
.sys-rows :deep(.sys-select),
.sys-select {
  height: 32px;
  width: 200px;
  padding: 0 8px;
  font-size: 12px;
}
.sound-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sound-wrap .sys-select {
  width: 160px;
}
.preview-btn {
  height: 32px;
  padding: 0 10px;
  font-size: 11px;
}

/* 太极主题列表（列表项型选中范式：bg-surface + accent） */
.theme-hint {
  margin: 6px 10px var(--space-2);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.theme-list {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.theme-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--radius);
  color: var(--neutral-fg);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.theme-row:hover {
  background: var(--surface-hover);
}
.theme-row.active {
  background: var(--surface);
  color: var(--accent);
}
.theme-name {
  font-size: var(--text-sm);
  font-weight: 500;
}
.theme-swatches {
  display: flex;
  gap: 4px;
}
.swatch {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

/* 快捷键 */
.shortcut-hint {
  margin: 6px 10px var(--space-2);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.setting-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 10px 6px;
  min-height: 48px;
}
.setting-row + .setting-row {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.sr-left {
  flex: 1;
  min-width: 0;
}
.sr-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.label {
  font-size: var(--text-base);
  color: var(--neutral-fg);
  font-weight: 500;
}
.sr-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.kbd {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}
.rec-hint {
  font-size: var(--text-xs);
  color: var(--accent);
  animation: rec-pulse 1s ease-in-out infinite;
}
@keyframes rec-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.rec-btn {
  height: 28px;
  padding: 0 10px;
  font-size: var(--text-xs);
  color: var(--accent);
}
.rec-btn:hover {
  color: var(--accent);
}
.reset-btn {
  height: 28px;
  padding: 0 10px;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.reset-btn:hover {
  color: var(--danger);
}
</style>
