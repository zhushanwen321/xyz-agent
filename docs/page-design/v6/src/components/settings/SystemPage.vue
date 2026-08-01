<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UiSwitch from './UiSwitch.vue'
import SettingRow from './SettingRow.vue'
import GroupCard from './GroupCard.vue'
import {
  DEFAULT_SYSTEM_SETTINGS,
  SYSTEM_SOUNDS,
  SOUND_TONES,
  LOCALE_OPTIONS,
  THEME_OPTIONS,
  FONT_SIZE_OPTIONS,
  MUTED_SWATCHES,
  COLORFUL_SWATCHES,
  SHORTCUT_DEFAULT_KEYS,
  SHORTCUT_LABELS,
  SIMULATE_SAVE_FAILURE,
  SIMULATE_AUTO_RENAME_FAILURE,
  type SystemSettings,
  type SoundInfo,
} from '@/mock/system'
import { settingsOpen, settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'

/** SystemPage：系统设置（语言/外观/提示音/配色主题/快捷键）。
 * 编辑态 = 快照 diff（dirty）+ save-bar + 离开守卫（设计上下文 §4.3）；
 * 会话自动重命名走独立即时保存流（对齐真实组件 flag-file 语义）。*/

// ── 编辑态：draft + 快照（dirty = diff；净零翻转自动 clean）──
const draft = ref<SystemSettings>(JSON.parse(JSON.stringify(DEFAULT_SYSTEM_SETTINGS)))
const snapshot = ref<SystemSettings>(JSON.parse(JSON.stringify(DEFAULT_SYSTEM_SETTINGS)))
const settingsDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(snapshot.value))

// 快捷键 override（null = 未自定义；重置恢复默认）
const overrides = ref<Record<string, string | null>>({})
const savedOverrides = ref<Record<string, string | null>>({})
const shortcutsDirty = computed(() =>
  Object.keys(SHORTCUT_DEFAULT_KEYS).some(
    (k) => (overrides.value[k] ?? null) !== (savedOverrides.value[k] ?? null),
  ),
)
const anyDirty = computed(() => settingsDirty.value || shortcutsDirty.value)

// ── 提示音：清单 + 试听（Web Audio 合成音，不同声音不同音色）──
const soundList = ref<SoundInfo[]>(SYSTEM_SOUNDS)
const previewing = ref<'success' | 'error' | null>(null)
const previewErr = ref('')
let audioCtx: AudioContext | null = null
let previewTimer: ReturnType<typeof setTimeout> | undefined

function playTone(soundId: string): void {
  const spec = SOUND_TONES[soundId] ?? SOUND_TONES['__default__']
  audioCtx ??= new AudioContext()
  const ctx = audioCtx
  const t0 = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = spec.freq
  gain.gain.setValueAtTime(0.12, t0)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + spec.dur)
}

/** 试听当前选中声音（300ms loading 窗口；播放失败 → 行内错误，不静默） */
function previewSound(kind: 'success' | 'error'): void {
  if (previewing.value) return
  const id = kind === 'success' ? draft.value.successSound : draft.value.errorSound
  previewing.value = kind
  previewErr.value = ''
  try {
    playTone(id || '__default__')
  } catch {
    previewErr.value = '无法播放：音频设备不可用'
  }
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    if (previewing.value === kind) previewing.value = null
  }, 300)
}

// ── 会话自动重命名（独立即时保存流：成功「已保存」1.5s / 失败回滚 + 行内错误）──
const autoRename = ref(true)
const autoRenameBusy = ref(false)
const autoRenameOk = ref(false)
const autoRenameErr = ref('')
let autoRenameTimer: ReturnType<typeof setTimeout> | undefined
let autoRenameOkTimer: ReturnType<typeof setTimeout> | undefined

function toggleAutoRename(v: boolean): void {
  if (autoRenameBusy.value) return
  const prev = autoRename.value
  autoRename.value = v
  autoRenameBusy.value = true
  autoRenameErr.value = ''
  autoRenameOk.value = false
  clearTimeout(autoRenameTimer)
  autoRenameTimer = setTimeout(() => {
    autoRenameBusy.value = false
    if (SIMULATE_AUTO_RENAME_FAILURE) {
      autoRename.value = prev
      autoRenameErr.value = '保存失败：无法写入设置，请重试'
      return
    }
    autoRenameOk.value = true
    clearTimeout(autoRenameOkTimer)
    autoRenameOkTimer = setTimeout(() => {
      autoRenameOk.value = false
    }, 1500)
  }, 400)
}

// ── 页级保存 / 放弃（§4.3：mock 延迟 → 成功刷新快照 + 已保存 1.5s / 失败行内错误条）──
const saving = ref(false)
const saveError = ref('')
const savedFlash = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined

function save(): void {
  if (!anyDirty.value || saving.value) return
  saving.value = true
  saveError.value = ''
  savedFlash.value = false
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saving.value = false
    if (SIMULATE_SAVE_FAILURE) {
      saveError.value = '保存失败：设置服务不可达，请稍后重试'
      return
    }
    snapshot.value = JSON.parse(JSON.stringify(draft.value))
    savedOverrides.value = JSON.parse(JSON.stringify(overrides.value))
    savedFlash.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      savedFlash.value = false
    }, 1500)
  }, 600)
}

function discard(): void {
  if (saving.value) return
  cancelRecording()
  draft.value = JSON.parse(JSON.stringify(snapshot.value))
  overrides.value = JSON.parse(JSON.stringify(savedOverrides.value))
  saveError.value = ''
  savedFlash.value = false
}

// ── 快捷键重录（对齐真实组件：keydown 捕获 + Esc 取消 + 组合键持久化）──
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

/** 显示文本：有 override 用 override，否则默认键补平台修饰符（'n' → ⌘N / Ctrl+N） */
function displayShortcut(cmdId: string): string {
  const override = overrides.value[cmdId]
  if (override) return formatShortcut(override)
  const def = SHORTCUT_DEFAULT_KEYS[cmdId]
  if (!def) return ''
  return def.includes('+')
    ? formatShortcut(def)
    : isMac
      ? `⌘${def.toUpperCase()}`
      : `Ctrl+${def.toUpperCase()}`
}

const shortcutRows = computed(() =>
  Object.keys(SHORTCUT_DEFAULT_KEYS).map((id) => ({
    id,
    label: SHORTCUT_LABELS[id] ?? id,
    shortcut: displayShortcut(id),
  })),
)

function startRecording(cmdId: string): void {
  recordingId.value = cmdId
  window.addEventListener('keydown', onRecordKeydown, true)
}

function cancelRecording(): void {
  if (recordingId.value) window.removeEventListener('keydown', onRecordKeydown, true)
  recordingId.value = null
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
  const cmdId = recordingId.value
  if (cmdId) {
    overrides.value[cmdId] = parts.join('+')
    cancelRecording()
  }
}

function resetShortcut(cmdId: string): void {
  overrides.value[cmdId] = null
}

// ── 离开守卫（§4.3：nav 切页 / 关闭拦截 + beforeunload；弹窗内联自建）──
const confirmState = ref<null | { kind: 'leave' }>(null)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'system') return
    if (!anyDirty.value && !recordingId.value) return
    pendingLeave.value = page !== 'system' ? page : 'close'
    settingsPage.value = 'system'
    settingsOpen.value = true
    confirmState.value = { kind: 'leave' }
  },
  // flush: 'sync' —— closeSettings/nav select 同步栈内立即拦截，卸载不发生。
  { flush: 'sync' },
)
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (anyDirty.value || recordingId.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
/** 放弃 = 先还原快照 → anyDirty 归零 → sync watch 重入时守卫放行导航（防弹窗永久重开） */
function confirmDiscard(): void {
  const st = confirmState.value
  confirmState.value = null
  if (!st) return
  discard()
  if (pendingLeave.value === 'close') closeSettings()
  else if (pendingLeave.value) settingsPage.value = pendingLeave.value
}
const guardContinueRef = ref<HTMLElement | null>(null)
watch(confirmState, (v) => {
  if (v) nextTick(() => guardContinueRef.value?.focus())
})
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  cancelRecording()
  clearTimeout(saveTimer)
  clearTimeout(flashTimer)
  clearTimeout(previewTimer)
  clearTimeout(autoRenameTimer)
  clearTimeout(autoRenameOkTimer)
  audioCtx?.close().catch(() => {})
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">系统</h1>
        <p class="desc">应用级偏好：语言、外观、提示音、配色主题与快捷键。</p>
      </div>
    </header>

    <GroupCard title="语言与外观">
      <SettingRow label="语言" desc="界面显示语言与区域格式">
        <div class="select-wrap">
          <select v-model="draft.locale" class="sys-select" aria-label="语言">
            <option v-for="o in LOCALE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </SettingRow>
      <SettingRow label="外观模式" desc="亮色、暗色或跟随系统">
        <div class="select-wrap">
          <select v-model="draft.theme" class="sys-select" aria-label="外观模式">
            <option v-for="o in THEME_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </SettingRow>
      <SettingRow label="字体大小" desc="对话与界面正文的字体大小">
        <div class="select-wrap">
          <select v-model="draft.fontSize" class="sys-select" aria-label="字体大小">
            <option v-for="o in FONT_SIZE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </SettingRow>
      <SettingRow label="后台完成提示音" desc="后台任务完成时播放提示音">
        <UiSwitch :checked="draft.completionSound" aria-label="后台完成提示音" @update:checked="draft.completionSound = $event" />
      </SettingRow>
      <SettingRow label="会话自动重命名" desc="新会话自动生成简洁标题，切换即保存">
        <span v-if="autoRenameBusy" class="spin" aria-hidden="true"></span>
        <span v-else-if="autoRenameErr" class="row-err">{{ autoRenameErr }}</span>
        <span v-else-if="autoRenameOk" class="row-ok">已保存</span>
        <UiSwitch :checked="autoRename" :disabled="autoRenameBusy" aria-label="会话自动重命名" @update:checked="toggleAutoRename" />
      </SettingRow>
    </GroupCard>

    <GroupCard title="提示音">
      <SettingRow label="成功音" desc="任务成功完成时播放">
        <div class="select-wrap">
          <select v-model="draft.successSound" class="sys-select" aria-label="成功音">
            <option value="">系统默认</option>
            <option v-for="s in soundList" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button class="btn btn-secondary btn-dense preview-btn" :disabled="!!previewing" aria-label="试听成功音" @click="previewSound('success')">
          <svg v-if="previewing !== 'success'" class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          <span v-else class="spin"></span>
          {{ previewing === 'success' ? '试听中' : '试听' }}
        </button>
      </SettingRow>
      <SettingRow label="失败音" desc="任务失败时播放">
        <div class="select-wrap">
          <select v-model="draft.errorSound" class="sys-select" aria-label="失败音">
            <option value="">系统默认</option>
            <option v-for="s in soundList" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button class="btn btn-secondary btn-dense preview-btn" :disabled="!!previewing" aria-label="试听失败音" @click="previewSound('error')">
          <svg v-if="previewing !== 'error'" class="p-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          <span v-else class="spin"></span>
          {{ previewing === 'error' ? '试听中' : '试听' }}
        </button>
      </SettingRow>
      <p v-if="previewErr" class="preview-err">{{ previewErr }}</p>
    </GroupCard>

    <GroupCard title="配色主题">
      <p class="swatch-label">低饱和</p>
      <div class="swatch-row">
        <button v-for="sw in MUTED_SWATCHES" :key="sw.id" class="swatch-btn" :class="{ active: draft.themePreset === sw.id }" :aria-pressed="draft.themePreset === sw.id" @click="draft.themePreset = sw.id">
          <span class="swatch-dot" :style="{ background: sw.color }"></span>
          <span>{{ sw.label }}</span>
        </button>
      </div>
      <p class="swatch-label">彩色</p>
      <div class="swatch-row">
        <button v-for="sw in COLORFUL_SWATCHES" :key="sw.id" class="swatch-btn" :class="{ active: draft.themePreset === sw.id }" :aria-pressed="draft.themePreset === sw.id" @click="draft.themePreset = sw.id">
          <span class="swatch-dot" :style="{ background: sw.color }"></span>
          <span>{{ sw.label }}</span>
        </button>
      </div>
    </GroupCard>

    <GroupCard title="快捷键">
      <SettingRow v-for="row in shortcutRows" :key="row.id" :label="row.label" desc="点击重录后按下新组合键，Esc 取消">
        <template #badge>
          <span v-if="recordingId === row.id" class="rec-hint">正在录制…</span>
          <kbd v-else-if="row.shortcut" class="kbd">{{ row.shortcut }}</kbd>
        </template>
        <button class="btn btn-ghost btn-dense rec-btn" :title="recordingId === row.id ? '取消录制' : '重录快捷键'" @click="recordingId === row.id ? cancelRecording() : startRecording(row.id)">{{ recordingId === row.id ? '取消' : '重录' }}</button>
        <button v-if="overrides[row.id]" class="btn btn-ghost btn-dense reset-btn" title="恢复默认快捷键" @click="resetShortcut(row.id)">重置</button>
      </SettingRow>
    </GroupCard>

    <div v-if="anyDirty || savedFlash" class="save-bar">
      <span v-if="anyDirty" class="bar-badge"><span class="dot"></span>未保存</span>
      <span v-if="saveError" class="sb-error">{{ saveError }}</span>
      <span v-if="savedFlash" class="sb-saved">
        <svg class="ok-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        已保存
      </span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-dense" :disabled="saving || !anyDirty" @click="discard">放弃</button>
      <button class="btn btn-default btn-dense" :disabled="saving || !anyDirty" data-testid="system-save-btn" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </div>

    <div
      v-if="confirmState"
      class="guard-mask"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sys-guard-title"
      @click.self="confirmState = null"
      @keydown.esc="confirmState = null"
    >
      <div class="guard-dialog">
        <div class="guard-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="guard-title" id="sys-guard-title">放弃未保存的改动？</div>
        <div class="guard-desc">系统设置有未保存的修改，离开后将丢失。可以先保存再离开，或直接放弃。</div>
        <div class="guard-actions">
          <button ref="guardContinueRef" class="btn btn-default btn-dense" @click="confirmState = null">继续编辑</button>
          <button class="btn btn-danger btn-dense" data-testid="system-discard-btn" @click="confirmDiscard">放弃改动</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
.head-text {
  min-width: 0;
}
.title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* 行内 select（32px dense，对齐真实组件 SelectTrigger h-8） */
.select-wrap {
  position: relative;
}
.select-chevron {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  pointer-events: none;
  color: var(--neutral-dim);
  opacity: 0.5;
}
.sys-select {
  height: 32px;
  width: 180px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 28px 0 10px;
  font-size: 12px;
  color: var(--neutral-fg);
  outline: none;
  cursor: pointer;
  appearance: none;
  transition: border-color var(--duration-fast) var(--ease), box-shadow var(--duration-fast) var(--ease);
}
.sys-select:focus-visible {
  border-color: transparent;
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}

/* 试听按钮 + 行内错误 */
.preview-btn svg {
  width: 13px;
  height: 13px;
}
.preview-err {
  margin: 0 6px var(--space-2);
  font-size: var(--text-sm);
  color: var(--danger);
}

/* 行内状态反馈（autoRename 即时保存流） */
.row-ok {
  font-size: var(--text-xs);
  color: var(--success);
  font-weight: 500;
}
.row-err {
  font-size: var(--text-xs);
  color: var(--danger);
}

/* spinner（按钮/badge 内通用） */
.spin {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 配色预设 swatch（圆点 = 数据色；选中 accent 环，无彩色侧边条） */
.swatch-label {
  margin: var(--space-2) 6px var(--space-2);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--neutral-mid);
}
.swatch-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.swatch-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--neutral-fg);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.swatch-btn:hover {
  background: var(--accent-soft);
}
.swatch-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.swatch-dot {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  flex-shrink: 0;
}

/* 快捷键：kbd / 录制提示 / 行内按钮 */
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
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
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

/* save-bar（sticky 底部悬浮条：未保存 + 错误/已保存反馈 + 放弃/保存） */
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  position: sticky;
  bottom: 0;
  z-index: var(--z-sticky);
  margin-top: var(--space-6);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.bar-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-sm);
  color: var(--warn);
  font-weight: 600;
  flex-shrink: 0;
}
.bar-badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warn);
}
.sb-error {
  font-size: var(--text-sm);
  color: var(--danger);
}
.sb-saved {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--success);
  font-weight: 600;
  flex-shrink: 0;
}
.ok-ico {
  width: 14px;
  height: 14px;
}
.spacer {
  flex: 1;
}

/* 离开确认弹窗（spec C2：mask + bg-card dialog + warn icon） */
.guard-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
}
.guard-dialog {
  width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.guard-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--warn);
}
.guard-icon svg {
  width: 16px;
  height: 16px;
}
.guard-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.guard-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
}
.guard-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

@media (prefers-reduced-motion: reduce) {
  .spin,
  .rec-hint {
    animation: none;
  }
  .rec-hint {
    opacity: 0.7;
  }
}
</style>
