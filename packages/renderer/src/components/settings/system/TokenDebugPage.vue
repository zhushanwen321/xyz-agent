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
import { useI18n } from 'vue-i18n'
import { GroupCard } from '@xyz-agent/ui/features/settings'
import { TAIJI_THEMES } from '@/composables/useTaijiThemes'

const { t } = useI18n()

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
    <header class="flex items-start justify-between gap-4 mb-4">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-neutral-fg">{{ t('settings.tokenDebug') }}</h1>
        <p class="mt-1 text-sm text-neutral-mid">{{ t('settings.tokenDebugPage.subtitle') }}</p>
      </div>
      <div class="flex gap-2 shrink-0">
        <Button variant="ghost" size="dense" @click="resetAll">{{ t('settings.tokenDebugPage.resetAll') }}</Button>
      </div>
    </header>

    <GroupCard :title="t('settings.tokenDebugPage.presetTitle')">
      <div class="flex flex-col gap-0.5 px-2.5 pt-1.5 pb-2.5">
        <UiButton
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          type="button"
          variant="ghost"
          class="h-auto flex items-center justify-between px-3 py-2.5 rounded-md text-neutral-fg cursor-pointer transition-colors"
          :class="{ active: th.label === activeThemeLabel, 'bg-surface text-accent': th.label === activeThemeLabel }"
          :aria-pressed="th.label === activeThemeLabel"
          @click="applyThemeNow(th.label)"
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
        </UiButton>
      </div>
    </GroupCard>

    <GroupCard :title="t('settings.tokenDebugPage.fontTitle')">
      <div class="grid grid-cols-4 gap-2 px-2.5 pt-1.5 pb-1">
        <UiButton
          v-for="f in FONT_SCALES"
          :key="f.name"
          type="button"
          variant="ghost"
          class="h-auto flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-md border border-border text-neutral-fg transition-all"
          :class="{ 'border-accent bg-accent-soft': fontScale === f.value }"
          :aria-pressed="fontScale === f.value"
          @click="applyFontScale(f.value)"
        >
          <span class="text-sm font-semibold">{{ f.name }}</span>
          <span class="text-xs text-neutral-mid">{{ f.desc }}</span>
        </UiButton>
      </div>
      <p class="px-2.5 pb-2.5 text-xs text-neutral-mid">
        {{ t('settings.tokenDebugPage.fontHint', { size: resolvedBasePx }) }}
      </p>
    </GroupCard>

    <GroupCard
      v-for="g in tokenRows"
      :key="g.title"
      :title="g.title"
    >
      <div class="px-2.5 pt-1 pb-2 divide-y divide-border/50">
        <div v-for="row in g.rows" :key="row.name" class="flex items-center gap-2.5 py-1.5 px-1.5 font-mono text-xs">
          <span class="flex-1 text-neutral-fg">{{ row.name }}</span>
          <span
            class="size-[18px] rounded-sm border border-border shrink-0"
            :style="{ background: row.value.startsWith('#') || row.value.startsWith('rgb') ? row.value : 'transparent' }"
          />
          <span class="text-neutral-mid min-w-[120px] text-right">{{ row.value || '—' }}</span>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script lang="ts">
import { Button as UiButton } from '@/components/ui/button'
export default { components: { UiButton } }
</script>

