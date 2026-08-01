<script setup lang="ts">
import { ref } from 'vue'
import { extensions as initialExtensions, type Extension } from '@/mock/sessions'
import GroupCard from './GroupCard.vue'
import UiSwitch from './UiSwitch.vue'
import UiInput from './UiInput.vue'

/** ExtensionPage：扩展管理。已安装扩展 group + 安装新扩展 group（npm/Local Dir/Git URL 三 tab）。*/
const extensions = ref<Extension[]>(JSON.parse(JSON.stringify(initialExtensions)))
const installTab = ref<'npm' | 'local' | 'git'>('npm')
const installValue = ref('')

const TIER_LABEL: Record<Extension['tier'], string> = {
  infrastructure: 'infrastructure',
  feature: 'feature',
}
const TIER_COLOR: Record<Extension['tier'], string> = {
  infrastructure: 'var(--neutral-faint)',
  feature: 'var(--neutral-dim)',
}

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

    <!-- 已安装扩展 -->
    <GroupCard title="已安装扩展">
      <div v-for="e in extensions" :key="e.id" class="ext-card">
        <div class="ext-info">
          <div class="ext-name-row">
            <span class="ext-name">{{ e.name }}</span>
            <span v-if="e.source === 'user'" class="badge-pill source user">user-installed</span>
            <span v-else-if="e.source === 'disc'" class="badge-pill source disc">discovered</span>
            <span v-if="e.scope === 'mandatory'" class="mandatory-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span class="mtext">Mandatory</span>
              <span class="tip">强制扩展 · 不可禁用/卸载 · 由 runtime 自动升级</span>
            </span>
            <span
              class="tier-label"
            >
              <span class="tier-dot" :style="{ background: TIER_COLOR[e.tier] }"></span>{{ TIER_LABEL[e.tier] }}
            </span>
          </div>
          <p class="ext-desc">{{ e.desc }}</p>
        </div>
        <!-- mandatory 扩展：单一锁标记操作簇 -->
        <div v-if="e.scope === 'mandatory'" class="ext-lockafford">
          <svg class="lockafford-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          <span class="lockafford-text">自动升级</span>
        </div>
        <!-- 可选扩展：启用 / 自动升级 / 升级 / 卸载 -->
        <div v-else class="ext-acts">
          <div class="act-toggle">
            <span class="act-label">启用</span>
            <UiSwitch :checked="e.enabled" @update:checked="toggleEnabled(e)" />
          </div>
          <div class="act-toggle">
            <span class="act-label">自动升级</span>
            <UiSwitch :checked="e.autoUpgrade" @update:checked="toggleAutoUpgrade(e)" />
          </div>
          <button class="btn btn-ghost btn-icon-sm" title="升级">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          </button>
          <button
            class="btn btn-danger btn-icon-sm"
            title="卸载"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </GroupCard>

    <!-- 安装新扩展 -->
    <GroupCard title="安装新扩展">
      <div class="install-tabs">
        <button class="itab" :class="{ active: installTab === 'npm' }" @click="installTab = 'npm'">npm</button>
        <button class="itab" :class="{ active: installTab === 'local' }" @click="installTab = 'local'">Local Dir</button>
        <button class="itab" :class="{ active: installTab === 'git' }" @click="installTab = 'git'">Git URL</button>
      </div>
      <div class="install-row">
        <UiInput
          v-model="installValue"
          :placeholder="installTab === 'npm' ? '@scope/extension-name' : installTab === 'local' ? '/path/to/extension' : 'https://github.com/org/repo.git'"
          :mono="true"
        />
        <button class="btn btn-default btn-md">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          安装
        </button>
      </div>
    </GroupCard>
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

.ext-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
}
.ext-card + .ext-card {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.ext-info {
  flex: 1;
  min-width: 0;
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
.badge-pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
}
.badge-pill.user {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge-pill.disc {
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
  margin-top: 4px;
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

.install-tabs {
  display: flex;
  gap: 2px;
  padding: var(--space-3) var(--space-4) 0;
}
.itab {
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-sm);
  font-weight: 500;
  transition: all var(--duration-fast) var(--ease);
}
.itab:hover {
  color: var(--neutral-fg);
}
.itab.active {
  background: var(--surface);
  color: var(--neutral-fg);
}
.install-row {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
</style>
