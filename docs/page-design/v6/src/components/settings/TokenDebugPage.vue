<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import GroupCard from './GroupCard.vue'
import SettingRow from './SettingRow.vue'
import UiSwitch from './UiSwitch.vue'

/** TokenDebugPage：四层颜色系统调试面板。
 * 实时调整 v6 设计 token（颜色/圆角/间距），直接 setProperty 到 :root。
 * 不持久化：重置 = removeProperty 还原 tokens.css :root 默认值。 */

const COLOR_TOKENS = [
  '--bg', '--surface', '--surface-hover', '--surface-2',
  '--bg-elevated', '--bg-input', '--bg-card', '--bg-sunken',
  '--neutral-fg', '--neutral-mid', '--neutral-dim', '--neutral-faint', '--neutral-ico',
  '--accent', '--success', '--warn', '--danger', '--info', '--reasoning',
]
const SIZE_TOKENS = [
  { name: '--radius-sm', max: 24 }, { name: '--radius', max: 24 },
  { name: '--radius-card', max: 24 }, { name: '--radius-lg', max: 24 },
  { name: '--space-1', max: 64 }, { name: '--space-2', max: 64 },
  { name: '--space-3', max: 64 }, { name: '--space-4', max: 64 },
  { name: '--space-6', max: 64 }, { name: '--space-8', max: 64 },
]
const RADIUS_TOKENS = SIZE_TOKENS.slice(0, 4)
const SPACE_TOKENS = SIZE_TOKENS.slice(4)
const BG_TOKENS = COLOR_TOKENS.slice(0, 8)
const NEUTRAL_TOKENS = COLOR_TOKENS.slice(8, 13)
const STATE_TOKENS = COLOR_TOKENS.slice(13)

/**
 * 主题机制说明：
 * - COLOR_TOKENS 进 color picker（hex 可编辑）；
 * - EFFECT_TOKENS 随主题整体切换但不进 picker（rgba 边框 / hover 派生色 / danger-fg）。
 * - 主题 entry 未提供的 key 在 applyTheme 时 reset 回 tokens.css :root 默认值。
 */

/** 太极主题族共用：V3 决策的暗色 border 三件套（比 v6 默认更克制） */
const TAIJI_BORDERS = { '--border': 'rgba(255,255,255,0.05)', '--border-strong': 'rgba(255,255,255,0.10)', '--hairline': 'rgba(255,255,255,0.04)' }
/** 太极暗色族共用：水墨降饱和状态色（V3 决策 §三） */
const TAIJI_STATES = { '--success': '#6a9b73', '--warn': '#a8904a', '--danger': '#b06060', '--danger-fg': '#f0f0f2', '--info': '#5e8a96', '--reasoning': '#80779e' }

const THEMES: Record<string, Record<string, string>> = {
  /* ── 太极主题族（2026-08-02 V3 配色决策 + 扩展变体）── */
  '太极 · 玄（纯灰 · V3 决策）': { '--bg': '#0f0f11', '--surface': '#1b1b1d', '--surface-hover': '#29292b', '--surface-2': '#212123', '--bg-elevated': '#262628', '--bg-input': '#141416', '--bg-card': '#18181a', '--bg-sunken': '#0f0f11', '--neutral-fg': '#dcdce0', '--neutral-mid': '#888890', '--neutral-dim': '#5e5e64', '--neutral-faint': '#383840', '--neutral-ico': '#74747c', '--neutral-ico-hover': '#dcdce0', '--accent': '#c8c8cd', '--accent-hover': '#dcdce0', '--accent-fg': '#1a1a1c', ...TAIJI_STATES, ...TAIJI_BORDERS },
  '太极 · 青墨（微青相）': { '--bg': '#0e1112', '--surface': '#1a1e1f', '--surface-hover': '#272d2e', '--surface-2': '#202526', '--bg-elevated': '#242a2b', '--bg-input': '#131718', '--bg-card': '#171b1c', '--bg-sunken': '#0e1112', '--neutral-fg': '#d9dfe0', '--neutral-mid': '#858e8f', '--neutral-dim': '#5b6465', '--neutral-faint': '#363d3e', '--neutral-ico': '#717b7c', '--neutral-ico-hover': '#d9dfe0', '--accent': '#93b5b8', '--accent-hover': '#a9c6c8', '--accent-fg': '#101a1c', ...TAIJI_STATES, ...TAIJI_BORDERS },
  '太极 · 黛蓝（微蓝相）': { '--bg': '#0f1013', '--surface': '#1b1c20', '--surface-hover': '#292b32', '--surface-2': '#212329', '--bg-elevated': '#26272e', '--bg-input': '#14161a', '--bg-card': '#181a20', '--bg-sunken': '#0f1013', '--neutral-fg': '#dcdde3', '--neutral-mid': '#888a93', '--neutral-dim': '#5e6069', '--neutral-faint': '#383a42', '--neutral-ico': '#74767f', '--neutral-ico-hover': '#dcdde3', '--accent': '#9aa7c4', '--accent-hover': '#b2bdd4', '--accent-fg': '#14161d', ...TAIJI_STATES, ...TAIJI_BORDERS },
  '太极 · 暖墨（微暖相 · 宣纸）': { '--bg': '#121110', '--surface': '#1d1c1a', '--surface-hover': '#2c2b28', '--surface-2': '#242322', '--bg-elevated': '#282723', '--bg-input': '#171615', '--bg-card': '#1b1a18', '--bg-sunken': '#121110', '--neutral-fg': '#e0dfdb', '--neutral-mid': '#918e89', '--neutral-dim': '#65625e', '--neutral-faint': '#413f3b', '--neutral-ico': '#7d7b76', '--neutral-ico-hover': '#e0dfdb', '--accent': '#c9c2b4', '--accent-hover': '#dbd5c8', '--accent-fg': '#1d1b17', ...TAIJI_STATES, ...TAIJI_BORDERS },
  // 朱印：danger 向玫红偏移 (#a85568)，避免与枯朱 accent 撞色
  '太极 · 朱印（灰底枯朱 accent）': { '--bg': '#0f0f11', '--surface': '#1b1b1d', '--surface-hover': '#29292b', '--surface-2': '#212123', '--bg-elevated': '#262628', '--bg-input': '#141416', '--bg-card': '#18181a', '--bg-sunken': '#0f0f11', '--neutral-fg': '#dcdce0', '--neutral-mid': '#888890', '--neutral-dim': '#5e5e64', '--neutral-faint': '#383840', '--neutral-ico': '#74747c', '--neutral-ico-hover': '#dcdce0', '--accent': '#bd7b6c', '--accent-hover': '#cf927f', '--accent-fg': '#1f1210', '--success': '#6a9b73', '--warn': '#a8904a', '--danger': '#a85568', '--danger-fg': '#f5f0f1', '--info': '#5e8a96', '--reasoning': '#80779e', ...TAIJI_BORDERS },
  // 皓：亮色（白鱼）。border 反转为黑色透明；accent 为墨黑（白底深字按钮）
  '太极 · 皓（亮色 · 白鱼）': { '--bg': '#f2f2f3', '--surface': '#ffffff', '--surface-hover': '#dedee2', '--surface-2': '#e9e9ec', '--bg-elevated': '#ffffff', '--bg-input': '#e9e9ec', '--bg-card': '#f8f8f9', '--bg-sunken': '#f2f2f3', '--neutral-fg': '#26262b', '--neutral-mid': '#6e6e76', '--neutral-dim': '#a0a0a8', '--neutral-faint': '#cfcfd4', '--neutral-ico': '#83838c', '--neutral-ico-hover': '#26262b', '--accent': '#33333a', '--accent-hover': '#4a4a52', '--accent-fg': '#f4f4f5', '--success': '#3e7c4c', '--warn': '#8a6d2a', '--danger': '#a84545', '--danger-fg': '#faf5f5', '--info': '#3f7383', '--reasoning': '#6c6096', '--border': 'rgba(0,0,0,0.07)', '--border-strong': 'rgba(0,0,0,0.14)', '--hairline': 'rgba(0,0,0,0.04)' },

  /* ── v6 遗留主题（对照用，未随太极决策更新）── */
  '冷蓝暗色（v6 默认）': { '--bg': '#1a1b1f', '--surface': '#272830', '--surface-hover': '#363740', '--surface-2': '#2e2f38', '--bg-elevated': '#313239', '--bg-input': '#1e1f24', '--bg-card': '#22242c', '--bg-sunken': '#1a1b1f', '--neutral-fg': '#e5e7eb', '--neutral-mid': '#9ca3af', '--neutral-dim': '#7d8494', '--neutral-faint': '#4b5563', '--neutral-ico': '#8b8d94', '--accent': '#4f8ef7', '--success': '#22c55e', '--warn': '#b08a3e', '--danger': '#ef4444', '--info': '#38bdf8', '--reasoning': '#a78bfa' },
  '暖色暗色': { '--bg': '#1c1a17', '--surface': '#2a2622', '--surface-hover': '#3a342e', '--surface-2': '#322c27', '--bg-elevated': '#363029', '--bg-input': '#201d1a', '--bg-card': '#25211d', '--bg-sunken': '#1c1a17', '--neutral-fg': '#f0ede8', '--neutral-mid': '#a8a098', '--neutral-dim': '#857d75', '--neutral-faint': '#4a4540', '--neutral-ico': '#908880', '--accent': '#d97706', '--accent-hover': '#e8963c', '--success': '#22c55e', '--warn': '#eab308', '--danger': '#ef4444', '--info': '#38bdf8', '--reasoning': '#a78bfa' },
  '紫色暗色': { '--bg': '#1a1a1f', '--surface': '#272730', '--surface-hover': '#363640', '--surface-2': '#2e2e38', '--bg-elevated': '#313140', '--bg-input': '#1e1e24', '--bg-card': '#22222c', '--bg-sunken': '#1a1a1f', '--neutral-fg': '#e5e7eb', '--neutral-mid': '#9ca3af', '--neutral-dim': '#7d7d8c', '--neutral-faint': '#4b4b55', '--neutral-ico': '#8b8b94', '--accent': '#8b5cf6', '--accent-hover': '#a78bfa', '--success': '#22c55e', '--warn': '#b08a3e', '--danger': '#ef4444', '--info': '#38bdf8', '--reasoning': '#a78bfa' },
  '高对比暗色': { '--bg': '#0d0d10', '--surface': '#1e1e24', '--surface-hover': '#2e2e38', '--surface-2': '#262630', '--bg-elevated': '#2a2a35', '--bg-input': '#141418', '--bg-card': '#1a1a20', '--bg-sunken': '#0d0d10', '--neutral-fg': '#ffffff', '--neutral-mid': '#b0b0b8', '--neutral-dim': '#888894', '--neutral-faint': '#505058', '--neutral-ico': '#9898a4', '--accent': '#5b9eff', '--accent-hover': '#7cb3ff', '--success': '#4ade80', '--warn': '#facc15', '--danger': '#f87171', '--info': '#38bdf8', '--reasoning': '#c4b5fd' },
  '灰阶无彩色（V4 被否方案 · 仅对照）': { '--bg': '#1a1a1a', '--surface': '#262626', '--surface-hover': '#363636', '--surface-2': '#2e2e2e', '--bg-elevated': '#313131', '--bg-input': '#1e1e1e', '--bg-card': '#222222', '--bg-sunken': '#1a1a1a', '--neutral-fg': '#e5e5e5', '--neutral-mid': '#9c9c9c', '--neutral-dim': '#7d7d7d', '--neutral-faint': '#4b4b4b', '--neutral-ico': '#8b8b8b', '--accent': '#9ca3af', '--accent-hover': '#b0b6bd', '--accent-fg': '#1a1a1c', '--success': '#9ca3af', '--warn': '#9ca3af', '--danger': '#9ca3af', '--info': '#9ca3af', '--reasoning': '#9ca3af' },
}
const themeEntries = Object.entries(THEMES)
const themeSwatch = (t: Record<string, string>) => [t['--accent'], t['--neutral-fg'], t['--surface'], t['--bg']]

/** 当前激活的主题名（首次加载 = 玄主题，与 tokens.css :root 默认值一致） */
const currentThemeName = ref('太极 · 玄（纯灰 · V3 决策）')

/** 随主题整体切换但不进 color picker 的效果 token（rgba 边框 / hover 派生色 / danger-fg） */
const EFFECT_TOKENS = ['--border', '--border-strong', '--hairline', '--accent-hover', '--neutral-ico-hover', '--danger-fg']

// ── 工具：hex <-> hsl，token 读写 ──
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let hh = 0, s = 0; const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) hh = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) hh = (b - r) / d + 2
    else hh = (r - g) / d + 4
    hh *= 60
  }
  return { h: Math.round(hh), s: Math.round(s * 100), l: Math.round(l * 100) }
}
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
function readTokenHex(name: string): string {
  const raw = readToken(name), m = raw.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x.trim()))
    const to = (n: number) => Math.round(n).toString(16).padStart(2, '0')
    return `#${to(p[0])}${to(p[1])}${to(p[2])}`
  }
  return raw
}
function writeToken(name: string, value: string): void { document.documentElement.style.setProperty(name, value) }
function resetToken(name: string): void { document.documentElement.style.removeProperty(name) }

// ── 响应式状态 ──
const colorValues = reactive<Record<string, string>>({})
const baselineColors = reactive<Record<string, string>>({})
const sizeValues = reactive<Record<string, number>>({})
const lightness = ref(0)        // -20 ~ +20
const saturation = ref(100)     // 0 ~ 200（百分比）
const hueShift = ref(0)         // -180 ~ +180°
const accentInput = ref('')
const followAccent = ref(false)
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

function refreshColorValues(): void { for (const t of COLOR_TOKENS) colorValues[t] = readTokenHex(t) }
function refreshBaseline(): void { for (const t of COLOR_TOKENS) baselineColors[t] = readTokenHex(t) }
function refreshSizeValues(): void {
  for (const s of SIZE_TOKENS) sizeValues[s.name] = parseInt(readToken(s.name), 10) || 0
}
function isDirty(t: string): boolean {
  return !!colorValues[t] && colorValues[t].toLowerCase() !== baselineColors[t]?.toLowerCase()
}
const dirty = computed(() => COLOR_TOKENS.some(isDirty))

// ── 1. 主题切换：先清空颜色 token + 效果 token，再批量写入；baseline 同步为新主题；滑块归零 ──
// --accent-fg 不在 COLOR_TOKENS（不需参与滑块 HSL 偏移），与 EFFECT_TOKENS 一起单独处理：theme 有则 write，无则 reset 回 tokens.css 默认
function applyTheme(name: string, theme: Record<string, string>): void {
  currentThemeName.value = name
  for (const t of COLOR_TOKENS) resetToken(t)
  resetToken('--accent-fg')
  for (const t of EFFECT_TOKENS) resetToken(t)
  for (const [k, v] of Object.entries(theme)) writeToken(k, v)
  refreshBaseline()
  lightness.value = 0; saturation.value = 100; hueShift.value = 0
  refreshColorValues(); accentInput.value = colorValues['--accent'] || ''
}

// ── 2. 全局滑块：对 baseline 应用 HSL 偏移后写回 ──
function applyGlobalAdjust(): void {
  for (const t of COLOR_TOKENS) {
    const base = baselineColors[t]; if (!base) continue
    const { h, s, l } = hexToHsl(base)
    writeToken(t, hslToHex(h + hueShift.value, s * (saturation.value / 100), Math.max(0, Math.min(100, l + lightness.value))))
  }
  refreshColorValues(); accentInput.value = colorValues['--accent'] || ''
}

// ── 3. 主色驱动：改 accent + 状态色跟随 accent 色相 ──
/** 开启"跟随 accent"时，记录各状态色与 accent 的色相差；accent 变化时按差值旋转 */
const stateHueDeltas: Record<string, number> = {}
function setAccent(v: string): void {
  accentInput.value = v; writeToken('--accent', v)
  if (followAccent.value) syncStateHueToAccent(v)
  refreshColorValues()
}
function onFollowToggle(v: boolean): void {
  followAccent.value = v
  if (v) {
    // 开启时记录各状态色与当前 accent 的色相差
    const accentH = hexToHsl(accentInput.value || baselineColors['--accent'] || '#4f8ef7').h
    for (const t of STATE_TOKENS) {
      const base = baselineColors[t]; if (!base) continue
      stateHueDeltas[t] = hexToHsl(base).h - accentH
    }
  } else {
    // 关闭时恢复各状态色到 baseline
    for (const t of STATE_TOKENS) { if (baselineColors[t]) writeToken(t, baselineColors[t]) }
    refreshColorValues()
  }
}
function syncStateHueToAccent(accentHex: string): void {
  // 各状态色色相 = 新 accent 色相 + 原始色相差（整体随 accent 旋转，保持相对关系）
  const accentH = hexToHsl(accentHex).h
  for (const t of STATE_TOKENS) {
    if (stateHueDeltas[t] === undefined) continue
    const base = baselineColors[t]; if (!base) continue
    const { s, l } = hexToHsl(base)
    writeToken(t, hslToHex(accentH + stateHueDeltas[t], s, l))
  }
}

// ── 4. 逐 token：color picker + hex 输入 ──
function onTokenColor(t: string, v: string): void {
  colorValues[t] = v; writeToken(t, v)
  // 如果改的是 accent 且 followAccent 开启，同步状态色
  if (t === '--accent' && followAccent.value) { accentInput.value = v; syncStateHueToAccent(v) }
}
function onTokenHex(t: string, v: string): void {
  const raw = v.trim()
  if (/^#?[0-9a-fA-F]{6}$/.test(raw)) {
    const hex = raw.startsWith('#') ? raw : `#${raw}`
    colorValues[t] = hex; writeToken(t, hex)
  } else { colorValues[t] = raw }
}
function onTokenReset(t: string): void { resetToken(t); colorValues[t] = readTokenHex(t) }

// ── 5. 圆角 / 间距：px 数字输入 ──
function onSizeInput(name: string, v: number): void { sizeValues[name] = v; writeToken(name, `${v}px`) }
function onSizeReset(name: string): void { resetToken(name); sizeValues[name] = parseInt(readToken(name), 10) || 0 }

// ── 顶部操作栏 ──
function resetAll(): void {
  for (const t of COLOR_TOKENS) resetToken(t)
  for (const s of SIZE_TOKENS) resetToken(s.name)
  resetToken('--accent-fg')
  for (const t of EFFECT_TOKENS) resetToken(t)
  refreshBaseline(); refreshColorValues(); refreshSizeValues()
  lightness.value = 0; saturation.value = 100; hueShift.value = 0
  followAccent.value = false; accentInput.value = colorValues['--accent'] || ''
  currentThemeName.value = '太极 · 玄（纯灰 · V3 决策）'
}
function exportJson(): void {
  const obj: Record<string, string> = {}
  for (const t of COLOR_TOKENS) obj[t] = readTokenHex(t)
  for (const s of SIZE_TOKENS) obj[s.name] = readToken(s.name)
  navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() => {
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 1500)
  }, () => {})
}

onMounted(() => {
  refreshBaseline(); refreshColorValues(); refreshSizeValues()
  accentInput.value = colorValues['--accent'] || ''
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">Token 调试</h1>
        <p class="desc">实时调整四层颜色系统 token（预设 / 全局 / 主色 / 精调 / 圆角间距）。</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-dense" :disabled="!dirty" @click="resetAll">重置全部</button>
        <button class="btn btn-secondary btn-dense" @click="exportJson">{{ copied ? '已复制' : '导出 JSON' }}</button>
      </div>
    </header>

    <GroupCard title="预设主题">
      <div v-for="[name, t] in themeEntries" :key="name" class="theme-row" :class="{ active: name === currentThemeName }" @click="applyTheme(name, t)">
        <span class="theme-name">{{ name }}</span>
        <div class="theme-swatches">
          <span v-for="(c, i) in themeSwatch(t)" :key="i" class="swatch" :style="{ background: c }"></span>
        </div>
      </div>
    </GroupCard>

    <GroupCard title="全局调整">
      <SettingRow label="明度偏移" :desc="`${lightness > 0 ? '+' : ''}${lightness}%`">
        <input type="range" min="-20" max="20" step="1" v-model.number="lightness" class="slider" @input="applyGlobalAdjust" />
        <span class="slider-val">{{ lightness > 0 ? '+' : '' }}{{ lightness }}</span>
      </SettingRow>
      <SettingRow label="饱和度" :desc="`${saturation}%`">
        <input type="range" min="0" max="200" step="1" v-model.number="saturation" class="slider" @input="applyGlobalAdjust" />
        <span class="slider-val">{{ saturation }}%</span>
      </SettingRow>
      <SettingRow label="色相旋转" :desc="`${hueShift}°`">
        <input type="range" min="-180" max="180" step="1" v-model.number="hueShift" class="slider" @input="applyGlobalAdjust" />
        <span class="slider-val">{{ hueShift }}°</span>
      </SettingRow>
    </GroupCard>

    <GroupCard title="主色驱动">
      <SettingRow label="accent 主色" desc="accent-soft / accent-ring 自动跟随">
        <input type="color" :value="colorValues['--accent'] || '#4f8ef7'" class="color-pick" @input="setAccent(($event.target as HTMLInputElement).value)" />
        <input type="text" :value="accentInput" class="hex-input" maxlength="7" @input="setAccent(($event.target as HTMLInputElement).value)" />
      </SettingRow>
      <SettingRow label="状态色跟随 accent 色相" desc="success/warn/danger/info/reasoning 旋转到与 accent 协调">
        <UiSwitch :checked="followAccent" aria-label="状态色跟随 accent" @update:checked="onFollowToggle" />
      </SettingRow>
    </GroupCard>

    <GroupCard title="背景层级">
      <SettingRow v-for="t in BG_TOKENS" :key="t" :label="t" :desc="colorValues[t] || ''">
        <template #badge><button v-if="isDirty(t)" class="token-reset" @click="onTokenReset(t)">重置</button></template>
        <input type="color" :value="colorValues[t] || '#000000'" class="color-pick" :class="{ dirty: isDirty(t) }" @input="onTokenColor(t, ($event.target as HTMLInputElement).value)" />
        <input type="text" :value="colorValues[t]" class="hex-input" maxlength="7" @input="onTokenHex(t, ($event.target as HTMLInputElement).value)" />
      </SettingRow>
    </GroupCard>

    <GroupCard title="文字 neutral">
      <SettingRow v-for="t in NEUTRAL_TOKENS" :key="t" :label="t" :desc="colorValues[t] || ''">
        <template #badge><button v-if="isDirty(t)" class="token-reset" @click="onTokenReset(t)">重置</button></template>
        <input type="color" :value="colorValues[t] || '#000000'" class="color-pick" :class="{ dirty: isDirty(t) }" @input="onTokenColor(t, ($event.target as HTMLInputElement).value)" />
        <input type="text" :value="colorValues[t]" class="hex-input" maxlength="7" @input="onTokenHex(t, ($event.target as HTMLInputElement).value)" />
      </SettingRow>
    </GroupCard>

    <GroupCard title="主色 + 状态色">
      <SettingRow v-for="t in STATE_TOKENS" :key="t" :label="t" :desc="colorValues[t] || ''">
        <template #badge><button v-if="isDirty(t)" class="token-reset" @click="onTokenReset(t)">重置</button></template>
        <input type="color" :value="colorValues[t] || '#000000'" class="color-pick" :class="{ dirty: isDirty(t) }" @input="onTokenColor(t, ($event.target as HTMLInputElement).value)" />
        <input type="text" :value="colorValues[t]" class="hex-input" maxlength="7" @input="onTokenHex(t, ($event.target as HTMLInputElement).value)" />
      </SettingRow>
    </GroupCard>

    <GroupCard title="圆角">
      <SettingRow v-for="s in RADIUS_TOKENS" :key="s.name" :label="s.name" :desc="readToken(s.name)">
        <input type="number" :value="sizeValues[s.name]" :max="s.max" min="0" step="1" class="num-input" @input="onSizeInput(s.name, Number(($event.target as HTMLInputElement).value))" />
        <span class="unit">px</span>
        <button class="token-reset" @click="onSizeReset(s.name)">重置</button>
      </SettingRow>
    </GroupCard>

    <GroupCard title="间距">
      <SettingRow v-for="s in SPACE_TOKENS" :key="s.name" :label="s.name" :desc="readToken(s.name)">
        <input type="number" :value="sizeValues[s.name]" :max="s.max" min="0" step="1" class="num-input" @input="onSizeInput(s.name, Number(($event.target as HTMLInputElement).value))" />
        <span class="unit">px</span>
        <button class="token-reset" @click="onSizeReset(s.name)">重置</button>
      </SettingRow>
    </GroupCard>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-6); }
.head-text { min-width: 0; }
.title { font-size: 20px; font-weight: 600; color: var(--neutral-fg); letter-spacing: -0.01em; }
.desc { margin-top: var(--space-2); font-size: var(--text-sm); color: var(--neutral-mid); }
.head-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.theme-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 6px; min-height: 40px; cursor: pointer; border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease); }
.theme-row + .theme-row { border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent); }
.theme-row:hover { background: var(--accent-soft); }
.theme-row.active { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-ring); }
.theme-row.active .theme-name { color: var(--accent); }
.theme-name { font-size: var(--text-base); color: var(--neutral-fg); font-weight: 500; }
.theme-swatches { display: flex; gap: 4px; }
.theme-swatches .swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.1); }
.slider { width: 140px; accent-color: var(--accent); }
.slider-val { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--neutral-mid); min-width: 36px; text-align: right; }
.color-pick { width: 32px; height: 32px; padding: 0; border: none; border-radius: var(--radius-sm); background: transparent; cursor: pointer; }
.color-pick::-webkit-color-swatch-wrapper { padding: 0; }
.color-pick::-webkit-color-swatch { border: 1px solid var(--border); border-radius: var(--radius-sm); }
.color-pick.dirty { box-shadow: 0 0 0 2px var(--accent); }
.hex-input { width: 80px; height: 28px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-input); padding: 0 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--neutral-fg); outline: none; }
.hex-input:focus { border-color: transparent; box-shadow: 0 0 0 1px var(--accent-ring) inset; }
.num-input { width: 56px; height: 28px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-input); padding: 0 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--neutral-fg); outline: none; text-align: right; }
.unit { font-size: var(--text-xs); color: var(--neutral-dim); }
.token-reset { height: 18px; padding: 0 6px; border-radius: var(--radius-sm); background: transparent; border: 1px solid var(--border); font-size: var(--text-2xs); color: var(--neutral-dim); cursor: pointer; transition: color var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease); }
.token-reset:hover { color: var(--accent); border-color: var(--accent); }
:deep(.sr-label .label) { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 400; }
</style>
