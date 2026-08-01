<script setup lang="ts">
import { ref, computed } from 'vue'
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
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">扩展</h1>
      <p class="desc">管理已安装扩展与安装新扩展。</p>
    </header>

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

      <div v-for="e in userExts" :key="e.id" class="ext-card">
        <div class="ext-info">
          <div class="ext-name-row">
            <span class="ext-name">{{ e.name }}</span>
            <span v-if="e.version" class="ver">{{ e.version }}</span>
            <!-- M6：source pill 仅 user 卡片（built-in/mandatory 省略） -->
            <span v-if="e.scope === 'user'" class="badge-pill source user">{{ e.source === 'disc' ? 'discovered' : 'user-installed' }}</span>
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
        <!-- user：启用开关 + 升级 + 卸载 -->
        <div class="ext-acts">
          <div class="act-toggle">
            <span class="act-label">启用</span>
            <UiSwitch :checked="e.enabled" :aria-label="e.name + ' 启用'" @update:checked="toggleEnabled(e)" />
          </div>
          <button class="btn btn-ghost btn-icon-sm" title="升级">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          </button>
          <button class="btn btn-danger btn-icon-sm" title="卸载">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </GroupCard>

    <!-- M1 多步安装流（InstallArea：npm 单步 + dir/git 发现→选择→安装 + 错误态） -->
    <InstallArea :installed-names="installedNames" @installed="handleInstalled" />

    <!-- M2 扫描目录管理（ScanDirsSection：discovery.json 三数组 · 项目/全局双分组） -->
    <ScanDirsSection />
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: var(--space-6);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: var(--z-sticky);
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
/* M5：version chip（mono 10px dim） */
.ver {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neutral-dim);
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.badge-pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
}
.badge-pill.source.user {
  background: var(--accent-soft);
  color: var(--accent);
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
  width: 13px;
  height: 13px;
}
.mandatory-badge .mtext {
  font-family: var(--font-sans);
}
.mandatory-badge .tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--neutral-fg);
  color: var(--bg);
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
/* M6：tier 轴仅 mandatory 卡片显示 */
.tier-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
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
  font-size: 11px;
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
  font-size: 10px;
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
  width: 16px;
  height: 16px;
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

</style>
