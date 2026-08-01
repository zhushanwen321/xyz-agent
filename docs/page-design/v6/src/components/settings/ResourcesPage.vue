<script setup lang="ts">
import { ref } from 'vue'
import UiInput from './UiInput.vue'

/** ResourcesPage：加载路径管理（Layer A）。
 * lp-card：lp-group-head（项目目录 + scope pill）+ lp-row（Checkbox + path + tag + 移动 + 移除）+ lp-add-row。*/
interface LoadPath {
  id: string
  path: string
  enabled: boolean
  tag: '系统' | '共享' | ''
  scope: 'project' | 'shared' | 'system'
}
const paths = ref<LoadPath[]>([
  { id: 'lp-1', path: '~/.zcode/skills', enabled: true, tag: '共享', scope: 'shared' },
  { id: 'lp-2', path: './.agents/skills', enabled: true, tag: '系统', scope: 'system' },
  { id: 'lp-3', path: './.agents/agents', enabled: false, tag: '', scope: 'project' },
])
const manualPath = ref('')
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">资源（Skill / Agent）</h1>
      <p class="desc">管理 Skill 与 Agent 的加载路径，决定 pi 从哪些目录发现资源。</p>
    </header>

    <section class="lp-card">
      <!-- group head -->
      <div class="lp-group-head">
        <span class="group-title">项目目录</span>
        <span class="scope-pill">project</span>
        <span class="spacer"></span>
        <span class="count">{{ paths.length }} 条</span>
      </div>

      <!-- rows -->
      <div v-for="(lp, i) in paths" :key="lp.id" class="lp-row">
        <input type="checkbox" class="lp-check" v-model="lp.enabled" />
        <span class="lp-path">{{ lp.path }}</span>
        <span v-if="lp.tag" class="lp-tag" :class="lp.scope">{{ lp.tag }}</span>
        <span v-else class="lp-tag-spacer"></span>
        <span class="spacer"></span>
        <div class="lp-actions">
          <button class="btn btn-ghost btn-icon move-btn" title="上移" :disabled="i === 0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" :disabled="i === paths.length - 1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon rm-btn" title="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- add row -->
      <div class="lp-add-row">
        <button class="btn btn-secondary btn-md dir-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          选择目录
        </button>
        <UiInput v-model="manualPath" placeholder="或手动输入路径" :mono="true" class="manual-input" />
        <button class="btn btn-default btn-md">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
      </div>
    </section>
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

.lp-card {
  background: var(--bg-card);
  border-radius: 10px;
  overflow: hidden;
}
.lp-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 44px;
}
.group-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.scope-pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
}
.spacer {
  flex: 1;
}
.count {
  font-size: var(--text-sm);
  color: var(--neutral-dim);
}

.lp-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.lp-check {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: all var(--duration-fast) var(--ease);
}
.lp-check:checked {
  background: var(--accent);
  border-color: var(--accent);
}
.lp-check:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 5px;
  height: 9px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.lp-path {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-tag {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.lp-tag.system {
  background: var(--surface-2);
  color: var(--neutral-mid);
}
.lp-tag.shared {
  background: var(--info-soft);
  color: var(--info);
}
.lp-tag-spacer {
  width: 44px;
  flex-shrink: 0;
}
.lp-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease);
}
.lp-row:hover .lp-actions {
  opacity: 1;
}
.move-btn,
.rm-btn {
  width: 28px;
  height: 28px;
}
.move-btn svg,
.rm-btn svg {
  width: 14px;
  height: 14px;
}
.move-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.rm-btn:hover {
  color: var(--danger);
}

.lp-add-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.manual-input {
  flex: 1;
}
</style>
