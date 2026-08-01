<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { extensions as initialExtensions, type Extension } from '@/mock/sessions'
import GroupCard from './GroupCard.vue'
import UiSwitch from './UiSwitch.vue'
import InstallArea, { type InstalledPayload } from './InstallArea.vue'
import ScanDirsSection from './ScanDirsSection.vue'

/** ExtensionPage：扩展管理。按 scope 分两组（mandatory 系统强制 / user 用户安装），
 * 各自 group 头带 scope pill + count；卡内 version chip + tools 折叠 + 操作簇。
 * 安装流（InstallArea）+ 扫描目录管理（ScanDirsSection）为独立子组件。*/
const extensions = ref<Extension[]>(JSON.parse(JSON.stringify(initialExtensions)))
/** tools 折叠态（spec §2：默认折叠「N tools ▸」，展开显 tool 名 + 收起） */
const toolsOpen = ref<Record<string, boolean>>({})
/** 安装区已存在校验用的现有扩展名清单 */
const installedNames = computed(() => extensions.value.map((e) => e.name))
/** 安装成功（npm 直装 / dir+git 候选批量）→ 新扩展加入「用户安装」组，实时可见 */
function handleInstalled(p: InstalledPayload) {
  extensions.value.push({
    id: 'e-' + Date.now(),
    name: p.name,
    desc: p.desc,
    version: p.version,
    tools: p.tools,
    scope: 'user',
    source: 'user',
    tier: 'feature',
    enabled: true,
    autoUpgrade: false,
  })
}

const TIER_LABEL: Record<Extension['tier'], string> = {
  infrastructure: 'infrastructure',
  feature: 'feature',
}
const TIER_COLOR: Record<Extension['tier'], string> = {
  infrastructure: 'var(--neutral-faint)',
  feature: 'var(--neutral-dim)',
}

const mandatoryExts = computed(() => extensions.value.filter((e) => e.scope === 'mandatory'))
const userExts = computed(() => extensions.value.filter((e) => e.scope === 'user'))

function toggleEnabled(e: Extension) {
  if (e.scope === 'mandatory') return
  e.enabled = !e.enabled
}
function toggleAutoUpgrade(e: Extension) {
  if (e.scope === 'mandatory') return
  e.autoUpgrade = !e.autoUpgrade
}

/** 升级 mock：upgrading 600ms → 成功 bump 版本 + 行内 success-note；offline-sync 固定失败演示错误条 */
const upgrading = ref<Record<string, boolean>>({})
const upgradeError = ref<Record<string, string>>({})
/** 成功反馈（spec §8 Toast 的 demo 简化：页面级 success-note 2s 消失） */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let upgradeTimer: ReturnType<typeof setTimeout> | undefined

function nextVersion(v: string): string {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return v
  return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}
function flashNotice(msg: string) {
  notice.value = msg
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = ''), 2000)
}
function startUpgrade(e: Extension) {
  if (upgrading.value[e.id]) return
  upgrading.value[e.id] = true
  upgradeError.value[e.id] = ''
  clearTimeout(upgradeTimer)
  upgradeTimer = setTimeout(() => {
    upgrading.value[e.id] = false
    if (e.name === 'offline-sync') {
      // 固定失败：演示升级失败内联错误条（spec §8）
      upgradeError.value[e.id] = '升级失败：网络超时 · 检查网络后重试，或开启「自动升级」由后台重试'
      return
    }
    e.version = nextVersion(e.version ?? 'v0.0.0')
    flashNotice(`升级成功：${e.name} 已更新至 ${e.version}`)
  }, 600)
}

/** 卸载两段式确认（spec §6：danger icon + 扩展名 + 后果描述；uninstalling 期 disabled 防双击） */
const uninstallTarget = ref<Extension | null>(null)
const uninstalling = ref(false)
const uninstDlgEl = ref<HTMLElement | null>(null)
function openUninstall(e: Extension) {
  uninstallTarget.value = e
  uninstalling.value = false
  // 焦点管理：dialog 打开后聚焦容器，ESC 可关闭（ProviderUnsavedDialog 同范式）
  void nextTick(() => uninstDlgEl.value?.focus())
}
function closeUninstall() {
  if (uninstalling.value) return
  uninstallTarget.value = null
}
function confirmUninstall() {
  const t = uninstallTarget.value
  if (!t || uninstalling.value) return
  uninstalling.value = true
  clearTimeout(upgradeTimer)
  upgradeTimer = setTimeout(() => {
    extensions.value = extensions.value.filter((x) => x.id !== t.id)
    uninstalling.value = false
    uninstallTarget.value = null
    flashNotice(`已卸载：${t.name} 已从扩展列表移除`)
  }, 600)
}
/** 空态「添加扩展」→ 滚动到安装区 */
function scrollToInstall() {
  document.getElementById('install-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onBeforeUnmount(() => {
  clearTimeout(noticeTimer)
  clearTimeout(upgradeTimer)
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">扩展</h1>
      <p class="desc">管理已安装扩展与安装新扩展。</p>
    </header>

    <!-- 成功反馈（spec §8 Toast 的 demo 简化：页面级 success-note） -->
    <div v-if="notice" class="page-notice" data-testid="page-notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span>{{ notice }}</span>
    </div>

    <!-- 已安装 · mandatory（系统强制） -->
    <GroupCard>
      <template #head>
        <span class="g-title">已安装扩展</span>
        <span class="scope-pill mandatory">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          系统强制
        </span>
        <span class="g-count">{{ mandatoryExts.length }}</span>
        <span class="g-aux">runtime 自动安装/升级 · 不可禁用/卸载</span>
      </template>

      <!-- 空态（spec §8 三要素：图标 + 说明 + Primary 入口） -->
      <div v-if="mandatoryExts.length === 0" class="empty" data-testid="empty-mandatory">
        <div class="empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <span class="empty-text">暂无系统强制扩展</span>
        <span class="empty-hint">系统强制扩展由 runtime 自动安装并升级</span>
        <button class="btn btn-default btn-dense" @click="scrollToInstall">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          添加扩展
        </button>
      </div>

      <div v-for="e in mandatoryExts" :key="e.id" class="ext-card">
        <div class="ext-info">
          <div class="ext-name-row">
            <span class="ext-name">{{ e.name }}</span>
            <span v-if="e.version" class="ver">{{ e.version }}</span>
            <span class="mandatory-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span class="mtext">Mandatory</span>
              <span class="tip">强制扩展 · 不可禁用/卸载 · 由 runtime 自动升级</span>
            </span>
            <span class="tier-label">
              <span class="tier-dot" :style="{ background: TIER_COLOR[e.tier] }"></span>{{ TIER_LABEL[e.tier] }}
            </span>
          </div>
          <p class="ext-desc">{{ e.desc }}</p>
          <!-- M5：tools 折叠（默认「N tools ▸」，展开显 tool 名列表 + 收起） -->
          <div v-if="e.tools && e.tools.length" class="ext-tools">
            <button
              class="ext-tools-toggle"
              :class="{ expanded: toolsOpen[e.id] }"
              :aria-expanded="!!toolsOpen[e.id]"
              @click="toolsOpen[e.id] = !toolsOpen[e.id]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              {{ toolsOpen[e.id] ? '收起' : e.tools.length + ' tools' }}
            </button>
            <template v-if="toolsOpen[e.id]">
              <span v-for="t in e.tools" :key="t" class="tl">{{ t }}</span>
            </template>
          </div>
        </div>
        <!-- mandatory：单一锁标记操作簇 -->
        <div class="ext-acts">
          <div class="ext-lockafford">
            <svg class="lockafford-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            <span class="lockafford-text">自动升级</span>
          </div>
        </div>
      </div>
    </GroupCard>

    <!-- 已安装 · user（用户安装） -->
    <GroupCard>
      <template #head>
        <span class="g-title">已安装扩展</span>
        <span class="scope-pill user">用户安装</span>
        <span class="g-count">{{ userExts.length }}</span>
        <span class="g-aux">可开关 · 可升级 · 可卸载</span>
      </template>

      <!-- 空态（spec §8 三要素） -->
      <div v-if="userExts.length === 0" class="empty" data-testid="empty-user">
        <div class="empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        </div>
        <span class="empty-text">还没有安装任何扩展</span>
        <span class="empty-hint">从 npm 包名、本地目录或 Git URL 安装第一个扩展</span>
        <button class="btn btn-default btn-dense" data-testid="empty-add-btn" @click="scrollToInstall">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          添加扩展
        </button>
      </div>

      <template v-for="e in userExts" :key="e.id">
        <div class="ext-card" :class="{ 'has-err': !!upgradeError[e.id] }">
        <div class="ext-info">
          <div class="ext-name-row">
            <span class="ext-name">{{ e.name }}</span>
            <span v-if="e.version" class="ver" :class="{ up: upgrading[e.id] }">{{ upgrading[e.id] ? e.version + ' → ' + nextVersion(e.version) : e.version }}</span>
            <!-- M6：source pill 仅 user 卡片（built-in/mandatory 省略；spec §1 user=accent / disc=info） -->
            <span v-if="e.scope === 'user'" class="bd-src" :class="e.source">{{ e.source === 'disc' ? 'discovery' : 'user-installed' }}</span>
          </div>
          <p class="ext-desc">{{ e.desc }}</p>
          <!-- M7：自动升级独立 Switch 在信息块内（desc 下方），不进右侧操作簇 -->
          <div class="ext-autoup">
            <UiSwitch :checked="e.autoUpgrade" :aria-label="e.name + ' 自动升级'" @update:checked="toggleAutoUpgrade(e)" />
            <span class="autoup-label">自动升级</span>
          </div>
          <!-- M5：tools 折叠 -->
          <div v-if="e.tools && e.tools.length" class="ext-tools">
            <button
              class="ext-tools-toggle"
              :class="{ expanded: toolsOpen[e.id] }"
              :aria-expanded="!!toolsOpen[e.id]"
              @click="toolsOpen[e.id] = !toolsOpen[e.id]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              {{ toolsOpen[e.id] ? '收起' : e.tools.length + ' tools' }}
            </button>
            <template v-if="toolsOpen[e.id]">
              <span v-for="t in e.tools" :key="t" class="tl">{{ t }}</span>
            </template>
          </div>
        </div>
        <!-- user：启用开关 + 升级 + 卸载（disc 来源不显示卸载，spec §3） -->
        <div class="ext-acts">
          <div class="act-toggle">
            <span class="act-label">启用</span>
            <UiSwitch :checked="e.enabled" :aria-label="e.name + ' 启用'" @update:checked="toggleEnabled(e)" />
          </div>
          <button class="btn btn-ghost btn-icon-sm" :disabled="!!upgrading[e.id]" :title="upgrading[e.id] ? '升级中…' : '升级'" aria-label="升级" @click="startUpgrade(e)">
            <svg v-if="!upgrading[e.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v5"/><path d="M5.2 13a8 8 0 1 0 13.6 0"/><path d="m6 7 6 6 6-6"/></svg>
            <svg v-else class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          </button>
          <button v-if="e.source !== 'disc'" class="btn btn-danger btn-icon-sm" title="卸载" aria-label="卸载" @click="openUninstall(e)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
        </div>
        <!-- 升级失败内联错误条（spec §8：danger-soft 底 + danger 字 + AlertCircle「原因 + 下一步」） -->
        <div v-if="upgradeError[e.id]" class="upgrade-err" data-testid="upgrade-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
          <span>{{ upgradeError[e.id] }}</span>
        </div>
      </template>
    </GroupCard>

    <!-- 卸载两段式确认（spec §6：danger icon + 扩展名 + 后果描述 + 取消 ghost / 卸载 danger；uninstalling 期 disabled） -->
    <div
      v-if="uninstallTarget"
      ref="uninstDlgEl"
      class="uninst-mask"
      role="alertdialog"
      aria-modal="true"
      @click.self="closeUninstall"
      @keydown.esc="closeUninstall"
    >
      <div class="uninst-dialog">
        <div class="uninst-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="uninst-title">卸载 <span class="uninst-target">{{ uninstallTarget.name }}</span>？</div>
        <div class="uninst-desc">卸载后相关配置将被移除，该扩展提供的工具在新会话不再可用。此操作不可撤销。</div>
        <div class="uninst-foot">
          <button class="btn btn-ghost btn-dense" :disabled="uninstalling" @click="closeUninstall">取消</button>
          <button class="btn btn-danger btn-dense" :disabled="uninstalling" data-testid="confirm-uninstall-btn" @click="confirmUninstall">
            <svg v-if="uninstalling" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            {{ uninstalling ? '卸载中…' : '卸载' }}
          </button>
        </div>
      </div>
    </div>

    <!-- M1 多步安装流（InstallArea：npm 单步 + dir/git 发现→选择→安装 + 错误态） -->
    <InstallArea id="install-area" :installed-names="installedNames" @installed="handleInstalled" />

    <!-- M2 扫描目录管理（ScanDirsSection：discovery.json 三数组 · 项目/全局双分组） -->
    <ScanDirsSection />
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: var(--space-6);
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

/* 成功反馈 note（spec §8 Toast 的 demo 简化） */
.page-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--space-4);
  padding: 9px 14px;
  border-radius: var(--radius-sm);
  background: var(--success-soft);
  color: var(--success);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.page-notice svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

/* group 头（head slot 内）：标题 + scope pill + count + aux */
.g-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.scope-pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.scope-pill svg {
  width: 11px;
  height: 11px;
}
.g-count {
  font-size: var(--text-sm);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
}
.g-aux {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
}

.ext-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  /* group-card 自带 10px padding，行内仅留呼吸 */
  padding: 6px var(--space-2);
}
.ext-card + .ext-card {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.ext-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ext-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.ext-name {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--neutral-fg);
  font-family: var(--font-sans);
}
/* M5：version chip（mono 10px dim · spec pill 形态 999px；upgrading 显 → 目标版绿 chip） */
.ver {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  background: var(--surface-2);
  padding: 2px 7px;
  border-radius: 999px;
  flex-shrink: 0;
  white-space: nowrap;
}
.ver.up {
  color: var(--success);
  background: var(--success-soft);
}
/* M6：source Pill（spec §1：Pill 分类原语 · mono 10px · user=accent / disc=info） */
.bd-src {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 500;
  flex-shrink: 0;
}
.bd-src.user {
  background: var(--accent-soft);
  color: var(--accent);
}
.bd-src.disc {
  background: var(--info-soft);
  color: var(--info);
}
.mandatory-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  cursor: help;
}
.mandatory-badge svg {
  width: 11px;
  height: 11px;
}
.mandatory-badge .mtext {
  font-family: var(--font-sans);
}
/* tooltip：深底浅字浮层（spec §1：bg-elevated + border-strong + shadow-2 + neutral-fg，反色修复） */
.mandatory-badge .tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-2);
  color: var(--neutral-fg);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-2xs);
  font-weight: 500;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease);
  z-index: 10;
}
.mandatory-badge:hover .tip {
  opacity: 1;
}
/* M6：tier 轴仅 mandatory 卡片显示（spec：neutral-dim · mono 小字弱化限定） */
.tier-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.tier-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ext-desc {
  margin-top: 0;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* M5：tools 折叠区 */
.ext-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}
.ext-tools-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  cursor: pointer;
  background: transparent;
  border: 0;
  padding: 2px 0;
  font-family: var(--font-sans);
  transition: color var(--duration-fast) var(--ease);
}
.ext-tools-toggle:hover {
  color: var(--neutral-fg);
}
.ext-tools-toggle svg {
  width: 12px;
  height: 12px;
  transition: transform var(--duration) var(--ease);
}
.ext-tools-toggle.expanded svg {
  transform: rotate(90deg);
}
.ext-tools .tl {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}

/* M7：自动升级独立 Switch（信息块内 desc 下方） */
.ext-autoup {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
}
.autoup-label {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

.ext-acts {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.ext-lockafford {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  color: var(--neutral-dim);
  font-size: var(--text-sm);
}
.lockafford-ico {
  width: 13px;
  height: 13px;
}
.act-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.act-label {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* 升级失败内联错误条（spec §8：danger-soft 底 + danger 字 + AlertCircle「原因 + 下一步」） */
.upgrade-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 var(--space-2) 6px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.upgrade-err svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-top: 1px;
}

/* 空态（spec §8：图标 + 说明 + Primary 入口三要素） */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
}
.empty-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--neutral-dim);
}
.empty-ico svg {
  width: 20px;
  height: 20px;
}
.empty-text {
  font-size: var(--text-base);
  color: var(--neutral-mid);
}
.empty-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}

/* 卸载确认（spec §6 ConfirmDialog：mask + bg-card + radius-lg + shadow-2 · danger-soft 图标底） */
.uninst-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
  outline: none;
}
.uninst-dialog {
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
.uninst-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
}
.uninst-icon svg {
  width: 16px;
  height: 16px;
}
.uninst-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.uninst-target {
  font-family: var(--font-mono);
}
.uninst-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
}
.uninst-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.uninst-foot .spin {
  width: 14px;
  height: 14px;
}
</style>
