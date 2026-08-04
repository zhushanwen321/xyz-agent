<script setup lang="ts">
/**
 * TokenDebugPage —— v6 Token 调试器（M2 精简版）。
 *
 * 功能：
 * - 太极主题即时切换（与 SystemPage 同源 TAIJI_THEMES，直接写 :root CSS 变量，不持久化）
 * - 字体大小档位（写 --font-scale-u，不持久化）
 * - 关键 token 实时取值（getComputedStyle 读 :root，反映当前主题/覆盖）
 *
 * 与 demo .tmp/v6/.../TokenDebugPage.vue 的差异：未实现逐 token 的 color picker /
 * HSL 滑块 / 全局色相偏移 / 导出 JSON。这些是高级调试能力，M2 先落地结构 + 基础调试，
 * 完整滑块版留作后续增强（TODO）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { GroupCard } from '@xyz-agent/ui/features/settings'
import { TAIJI_THEMES } from '@/composables/useTaijiThemes'

/** 写 / 删 :root CSS 变量（仅本调试页用，不持久化） */
function writeToken(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value)
}
function resetToken(name: string): void {
  document.documentElement.style.removeProperty(name)
}
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// ── 太极主题（即时切换，写 :root，不持久化） ──
const activeThemeLabel = ref<string>(TAIJI_THEMES[0].label)
function applyThemeNow(label: string): void {
  activeThemeLabel.value = label
  const th = TAIJI_THEMES.find((t) => t.label === label)
  if (!th) return
  // 暗色族玄、亮色族皓为 :root/[data-theme=light] 默认，preset='' 时清掉所有 preset 覆盖
  // 其余 4 主题通过 data-theme + data-theme-preset 触发 style.css 规则（与 store 路径一致），
  // 但调试页不走 store，直接写 :root inline override（reset 时清掉）
  resetToken('--accent')
  resetToken('--accent-hover')
  resetToken('--accent-fg')
  resetToken('--bg')
  resetToken('--surface')
  resetToken('--neutral-fg')
  // 用 inline override 模拟主题切换（取 TAIJI_THEMES.swatch 的 accent/fg/surface/bg 近似）
  writeToken('--accent', th.swatch[0])
  writeToken('--neutral-fg', th.swatch[1])
  writeToken('--surface', th.swatch[2])
  writeToken('--bg', th.swatch[3])
  refreshTokens()
}

// ── 字体大小档位 ──
interface FontScale { name: string; value: string | null; desc: string }
const FONT_SCALES: FontScale[] = [
  { name: '紧凑', value: '0.92', desc: '×0.92' },
  { name: '标准', value: null, desc: '×1.0（默认）' },
  { name: '偏大', value: '1.08', desc: '×1.08' },
  { name: '大', value: '1.16', desc: '×1.16' },
]
const fontScale = ref<string | null>(null)
const resolvedBasePx = ref('')
function refreshFontInfo(): void {
  resolvedBasePx.value = getComputedStyle(document.body).fontSize
}
function applyFontScale(v: string | null): void {
  fontScale.value = v
  if (v === null) resetToken('--font-scale-u')
  else writeToken('--font-scale-u', v)
  refreshFontInfo()
}

// ── 关键 token 实时取值 ──
const TOKEN_GROUPS = [
  { title: '背景层级', tokens: ['--bg', '--bg-sunken', '--surface', '--surface-hover', '--surface-2', '--bg-elevated', '--bg-input', '--bg-card'] },
  { title: '文字', tokens: ['--neutral-fg', '--neutral-mid', '--neutral-dim', '--neutral-faint', '--neutral-ico'] },
  { title: '主色 / 状态', tokens: ['--accent', '--accent-hover', '--accent-fg', '--success', '--warn', '--danger', '--info', '--reasoning'] },
  { title: '边框', tokens: ['--border', '--border-strong', '--hairline'] },
  { title: '圆角 / 间距', tokens: ['--radius-sm', '--radius', '--radius-card', '--radius-lg', '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8'] },
]
const tokenValues = ref<Record<string, string>>({})
function refreshTokens(): void {
  const out: Record<string, string> = {}
  for (const g of TOKEN_GROUPS) for (const tk of g.tokens) out[tk] = readToken(tk)
  tokenValues.value = out
}
const tokenRows = computed(() =>
  TOKEN_GROUPS.map((g) => ({
    title: g.title,
    rows: g.tokens.map((tk) => ({ name: tk, value: tokenValues.value[tk] ?? '' })),
  })),
)

function resetAll(): void {
  resetToken('--accent'); resetToken('--accent-hover'); resetToken('--accent-fg')
  resetToken('--bg'); resetToken('--surface'); resetToken('--neutral-fg')
  resetToken('--font-scale-u')
  activeThemeLabel.value = TAIJI_THEMES[0].label
  fontScale.value = null
  refreshFontInfo()
  refreshTokens()
}

onMounted(() => {
  refreshFontInfo()
  refreshTokens()
  window.addEventListener('resize', refreshFontInfo)
})
onUnmounted(() => {
  // 离开调试页时清掉本页的 inline override，避免污染其他页面
  resetAll()
  window.removeEventListener('resize', refreshFontInfo)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">Token 调试</h1>
        <p class="desc">实时调整四层颜色系统 token（预设 / 字体 / 取值）。调试改动不持久化，重置即还原。</p>
      </div>
      <div class="head-actions">
        <Button variant="ghost" size="dense" @click="resetAll">重置全部</Button>
      </div>
    </header>

    <GroupCard title="预设主题">
      <div class="theme-list">
        <button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          type="button"
          class="theme-row"
          :class="{ active: th.label === activeThemeLabel }"
          :aria-pressed="th.label === activeThemeLabel"
          @click="applyThemeNow(th.label)"
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

    <GroupCard title="字体大小">
      <div class="font-scale-row">
        <button
          v-for="f in FONT_SCALES"
          :key="f.name"
          type="button"
          class="fs-btn"
          :class="{ active: fontScale === f.value }"
          :aria-pressed="fontScale === f.value"
          @click="applyFontScale(f.value)"
        >
          <span class="fs-name">{{ f.name }}</span>
          <span class="fs-desc">{{ f.desc }}</span>
        </button>
      </div>
      <p class="font-hint">
        正文当前实际渲染 {{ resolvedBasePx }}。自适应已开启：视口 ≥2100px 自动 ×1.08、&lt;1400px 自动 ×0.95，与所选档位相乘、互不屏蔽。
      </p>
    </GroupCard>

    <GroupCard
      v-for="g in tokenRows"
      :key="g.title"
      :title="g.title"
    >
      <div class="token-list">
        <div v-for="row in g.rows" :key="row.name" class="token-row">
          <span class="tk-name">{{ row.name }}</span>
          <span
            class="tk-chip"
            :style="{ background: row.value.startsWith('#') || row.value.startsWith('rgb') ? row.value : 'transparent' }"
          />
          <span class="tk-value">{{ row.value || '—' }}</span>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script lang="ts">
import { Button } from '@/components/ui/button'
export default { components: { Button } }
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.head-text {
  min-width: 0;
}
.title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
}
.desc {
  margin-top: 4px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 太极主题列表（同 SystemPage 范式） */
.theme-list {
  padding: 6px 10px 10px;
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

/* 字体大小 */
.font-scale-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 6px 10px 4px;
}
.fs-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--neutral-fg);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease);
}
.fs-btn:hover {
  background: var(--surface-hover);
}
.fs-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.fs-name {
  font-size: var(--text-sm);
  font-weight: 600;
}
.fs-desc {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.font-hint {
  padding: 0 10px 10px;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}

/* token 取值列表 */
.token-list {
  padding: 4px 10px 8px;
}
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 6px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.token-row + .token-row {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.tk-name {
  flex: 1;
  color: var(--neutral-fg);
}
.tk-chip {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.tk-value {
  color: var(--neutral-mid);
  min-width: 120px;
  text-align: right;
}
</style>
