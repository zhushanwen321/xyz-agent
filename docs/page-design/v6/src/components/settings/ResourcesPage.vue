<script setup lang="ts">
import { ref, computed } from 'vue'
import UiInput from './UiInput.vue'

/** ResourcesPage：加载路径管理（Layer A）+ 资源预览（Layer B）。
 * Layer A：lp-card：lp-group-head（项目目录 + scope pill）+ lp-row（Checkbox + path + tag + 移动 + 移除）+ lp-add-row。
 * Layer B：rp-toolbar（标题 + count pill + 刷新 + 来源 tab）+ rp-list（资源项 name + rp-badge + desc）。*/
interface LoadPath {
  id: string
  path: string
  enabled: boolean
  tag: '系统' | '共享' | ''
  scope: 'project' | 'shared' | 'system'
}
const paths = ref<LoadPath[]>([
  { id: 'lp-1', path: '~/.xyz-agent/skills', enabled: true, tag: '共享', scope: 'shared' },
  { id: 'lp-2', path: './.agents/skills', enabled: true, tag: '系统', scope: 'system' },
  { id: 'lp-3', path: './.agents/agents', enabled: false, tag: '', scope: 'project' },
])
const manualPath = ref('')

function moveUp(i: number) {
  if (i <= 0) return
  const arr = paths.value
  ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
}
function moveDown(i: number) {
  const arr = paths.value
  if (i >= arr.length - 1) return
  ;[arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]
}

/** Layer B 资源预览（mock 数据） */
type Source = 'effective' | 'pi' | 'claude' | 'agents'
const sourceTab = ref<Source>('effective')
const SOURCE_LABEL: Record<Source, string> = {
  effective: 'effective',
  pi: 'pi',
  claude: 'claude',
  agents: 'agents',
}
interface RpItem {
  name: string
  source: Exclude<Source, 'effective'>
  desc: string
}
const rpItems = ref<RpItem[]>([
  { name: 'code-review', source: 'pi', desc: '审查代码变更，触发词：review、code review。' },
  { name: 'browser-use', source: 'claude', desc: '通过浏览器自动化测试前端 GUI。' },
  { name: 'cw-cli', source: 'agents', desc: '结构化编码工作流 CLI。' },
  { name: 'cr-fix', source: 'pi', desc: '修复 code-review 标记的必改问题。' },
])
const SOURCE_COLOR: Record<RpItem['source'], string> = {
  pi: 'var(--reasoning)',
  claude: 'var(--warn)',
  agents: 'var(--info)',
}
const filteredRp = computed(() => {
  if (sourceTab.value === 'effective') return rpItems.value
  return rpItems.value.filter((r) => r.source === sourceTab.value)
})
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
        <span class="scope-pill">仅当前项目</span>
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
          <button class="btn btn-ghost btn-icon move-btn" title="上移" aria-label="上移" :disabled="i === 0" @click="moveUp(i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" aria-label="下移" :disabled="i === paths.length - 1" @click="moveDown(i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon rm-btn" title="移除" aria-label="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

    <!-- Layer B：资源预览 -->
    <section class="rp-card">
      <div class="rp-toolbar">
        <span class="rp-title">资源预览</span>
        <span class="rp-count-pill">{{ filteredRp.length }}</span>
        <button class="btn btn-ghost btn-icon-sm rp-refresh" title="刷新" aria-label="刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        </button>
        <span class="spacer"></span>
        <div class="rp-tabs">
          <button
            v-for="(label, key) in SOURCE_LABEL"
            :key="key"
            class="rp-tab"
            :class="{ active: sourceTab === key }"
            @click="sourceTab = key as Source"
          >{{ label }}</button>
        </div>
      </div>

      <div class="rp-list">
        <div v-for="(r, i) in filteredRp" :key="r.name + i" class="rp-item">
          <div class="rp-name-row">
            <span class="rp-name">{{ r.name }}</span>
            <span class="rp-badge" :class="r.source">
              <span class="dot" :style="{ background: SOURCE_COLOR[r.source] }"></span>
              {{ r.source }}
            </span>
          </div>
          <p class="rp-desc">{{ r.desc }}</p>
        </div>
        <div v-if="filteredRp.length === 0" class="rp-empty">该来源暂无资源</div>
      </div>
    </section>
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
  border-radius: 6px;
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
  gap: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.lp-tag.system::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--neutral-dim);
  flex-shrink: 0;
}
.lp-tag.shared::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--info);
  flex-shrink: 0;
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

/* Layer B：资源预览 */
.rp-card {
  background: var(--bg-card);
  border-radius: 10px;
  overflow: hidden;
  margin-top: var(--space-4);
}
.rp-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 44px;
}
.rp-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.rp-count-pill {
  height: 18px;
  min-width: 18px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
}
.rp-refresh {
  color: var(--neutral-mid);
}
.rp-refresh:hover {
  color: var(--neutral-fg);
}
.rp-tabs {
  display: flex;
  gap: 2px;
}
.rp-tab {
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-sm);
  font-weight: 500;
  font-family: var(--font-mono);
  transition: all var(--duration-fast) var(--ease);
}
.rp-tab:hover {
  color: var(--neutral-fg);
}
.rp-tab.active {
  background: var(--surface);
  color: var(--neutral-fg);
}

.rp-list {
  display: flex;
  flex-direction: column;
}
.rp-item {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.rp-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.rp-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--neutral-fg);
}
.rp-badge {
  background: var(--surface-2);
  color: var(--neutral-mid);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  font-family: var(--font-mono);
}
.rp-badge .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rp-desc {
  margin-top: 4px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.rp-empty {
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--neutral-dim);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
</style>
