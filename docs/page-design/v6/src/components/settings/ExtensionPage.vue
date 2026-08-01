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
  infrastructure: '基础设施',
  feature: '功能',
}
const TIER_COLOR: Record<Extension['tier'], string> = {
  infrastructure: 'var(--info)',
  feature: 'var(--accent)',
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
            <span class="badge-pill source" :class="e.source">{{ e.source === 'user' ? '用户' : '内置' }}</span>
            <span v-if="e.scope === 'mandatory'" class="lock-ico" title="强制安装，不可卸载/关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>
            <span
              class="tier-dot"
              :title="TIER_LABEL[e.tier]"
              :style="{ background: TIER_COLOR[e.tier] }"
            ></span>
          </div>
          <p class="ext-desc">{{ e.desc }}</p>
        </div>
        <div class="ext-acts">
          <div class="act-toggle">
            <span class="act-label">启用</span>
            <UiSwitch :checked="e.enabled" :disabled="e.scope === 'mandatory'" @update:checked="toggleEnabled(e)" />
          </div>
          <div class="act-toggle">
            <span class="act-label">自动升级</span>
            <UiSwitch :checked="e.autoUpgrade" :disabled="e.scope === 'mandatory'" @update:checked="toggleAutoUpgrade(e)" />
          </div>
          <button class="btn btn-ghost btn-md" title="升级">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            升级
          </button>
          <button
            class="btn btn-danger btn-icon"
            :class="{ locked: e.scope === 'mandatory' }"
            :disabled="e.scope === 'mandatory'"
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
}
.title {
  font-size: 18px;
  font-weight: 700;
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
  font-weight: 600;
  color: var(--neutral-fg);
  font-family: var(--font-mono);
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
  background: var(--surface-2);
  color: var(--neutral-mid);
}
.lock-ico {
  display: inline-flex;
  color: var(--warn);
}
.lock-ico svg {
  width: 13px;
  height: 13px;
}
.tier-dot {
  width: 8px;
  height: 8px;
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
.act-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.act-label {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.btn-danger.locked {
  opacity: 0.35;
  cursor: not-allowed;
}
.btn-danger.locked:hover {
  background: transparent;
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
