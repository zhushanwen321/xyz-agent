<script setup lang="ts">
import { ref, computed } from 'vue'
import UiInput from './UiInput.vue'

/** ResourcesPage：加载路径管理（Layer A）+ 资源预览（Layer B）。
 * Layer A（spec §1）：单一 lp-card 内按作用域分两组——项目目录（projectPaths，含系统锁定目录）+
 * 全局目录（globalPaths），各组独立管理（↑↓ 组内排序 + 移除）+ 独立添加行（spec §3 校验链：
 * 非空 → 绝对路径格式 → 去重，错误 inline 提示）。
 * 系统锁定目录（~/.xyz-agent/skills）checked + disabled + lock，无 ↑↓ 不可排序（spec §8 状态矩阵）。
 * Layer B（spec §6/§7/§10）：来源 badge 语义色（pi=accent / claude=warn / agents=success），
 * 刷新按钮（secondary dense + spin + 1.5s 骨架），空态三要素（图标 28px neutral-faint + 说明 +
 * Primary 刷新），区分「全空」与「筛选空」。*/
interface LoadPath {
  id: string
  path: string
  enabled: boolean
  /** 系统锁定目录：不可关/不可移/不可排序（spec §8） */
  locked?: boolean
}
const projectPaths = ref<LoadPath[]>([
  { id: 'lp-1', path: '~/.xyz-agent/skills', enabled: true, locked: true },
  { id: 'lp-2', path: './.agents/skills', enabled: true },
])
const globalPaths = ref<LoadPath[]>([
  { id: 'lp-3', path: '~/work/shared-skills', enabled: true },
  { id: 'lp-4', path: '~/lib/company-skills', enabled: false },
])
const manualProjectPath = ref('')
const manualGlobalPath = ref('')
/** M4 添加路径校验（spec §3：非空 → 格式 → 去重；空则不操作不报错） */
const projectPathError = ref('')
const globalPathError = ref('')
const PATH_RE = /^(\/|~\/|[A-Za-z]:\\)/

function addPath(list: LoadPath[], input: { value: string }, err: { value: string }) {
  const v = input.value.trim()
  if (!v) {
    err.value = ''
    return
  }
  if (!PATH_RE.test(v)) {
    err.value = '路径格式不合法：需为绝对路径（如 /Users/... 或 ~/...）'
    return
  }
  if (list.some((p) => p.path === v)) {
    err.value = `路径已存在：${v} 已在列表中`
    return
  }
  list.push({ id: 'lp-' + Date.now(), path: v, enabled: true })
  input.value = ''
  err.value = ''
}
/** 模板中 ref 自动解包，包装为脚本侧 handler 以便传 Ref 本体 */
function addProjectPath() {
  addPath(projectPaths.value, manualProjectPath, projectPathError)
}
function addGlobalPath() {
  addPath(globalPaths.value, manualGlobalPath, globalPathError)
}

function moveUp(list: LoadPath[], i: number) {
  if (i <= 0) return
  ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
}
function moveDown(list: LoadPath[], i: number) {
  if (i >= list.length - 1) return
  ;[list[i + 1], list[i]] = [list[i], list[i + 1]]
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
/** M9：来源 badge 语义色（spec §6：pi=accent · claude=warn · agents=success · piinstall=info） */
const SOURCE_COLOR: Record<RpItem['source'], string> = {
  pi: 'var(--accent)',
  claude: 'var(--warn)',
  agents: 'var(--success)',
}
const filteredRp = computed(() => {
  if (sourceTab.value === 'effective') return rpItems.value
  return rpItems.value.filter((r) => r.source === sourceTab.value)
})

/** M10：刷新（demo：1.5s 骨架后恢复，mock 数据静态） */
const scanning = ref(false)
let scanTimer: ReturnType<typeof setTimeout> | undefined
function refresh() {
  if (scanning.value) return
  scanning.value = true
  clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    scanning.value = false
  }, 1500)
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">资源（Skill / Agent）</h1>
      <p class="desc">管理 Skill 与 Agent 的加载路径，决定 pi 从哪些目录发现资源。</p>
    </header>

    <section class="lp-card">
      <div class="lp-head">
        <span class="lp-title">加载路径</span>
        <span class="lp-hint">靠前 = 高优先级 · 项目目录 &gt; 全局目录</span>
      </div>

      <!-- ===== 项目目录组（含系统锁定目录） ===== -->
      <div class="lp-group-head">
        <span class="lp-group-name">项目目录</span>
        <span class="lp-group-scope project">仅当前项目</span>
        <span class="lp-group-hint">projectPaths</span>
      </div>

      <div v-for="(lp, i) in projectPaths" :key="lp.id" class="lp-row">
        <input
          type="checkbox"
          class="lp-check"
          :class="{ locked: lp.locked }"
          v-model="lp.enabled"
          :disabled="lp.locked"
          :aria-label="'启用 ' + lp.path"
        />
        <svg v-if="lp.locked" class="lp-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span class="lp-path" :class="{ forced: lp.locked }">{{ lp.path }}</span>
        <span v-if="lp.locked" class="lp-tag forced">系统</span>
        <span class="spacer"></span>
        <div v-if="!lp.locked" class="lp-actions">
          <button class="btn btn-ghost btn-icon move-btn" title="上移" aria-label="上移" :disabled="i === 0" @click="moveUp(projectPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" aria-label="下移" :disabled="i === projectPaths.length - 1" @click="moveDown(projectPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon rm-btn" title="移除" aria-label="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      <!-- 项目目录：添加行（spec §3 双方式：选择目录 + 手动填写校验） -->
      <div class="lp-add-row">
        <button class="btn btn-secondary btn-md dir-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          选择目录
        </button>
        <UiInput
          v-model="manualProjectPath"
          placeholder="/absolute/path/to/project-dir"
          :mono="true"
          class="manual-input"
          :error="!!projectPathError"
          @keydown.enter="addProjectPath"
        />
        <button class="btn btn-default btn-md" @click="addProjectPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
      </div>
      <div v-if="projectPathError" class="lp-add-error">
        <svg class="lp-add-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{{ projectPathError }}</span>
      </div>

      <!-- ===== 全局目录组 ===== -->
      <div class="lp-group-head">
        <span class="lp-group-name">全局目录</span>
        <span class="lp-group-scope global">所有项目共享</span>
        <span class="lp-group-hint">globalPaths</span>
      </div>

      <div v-for="(lp, i) in globalPaths" :key="lp.id" class="lp-row">
        <input type="checkbox" class="lp-check" v-model="lp.enabled" :aria-label="'启用 ' + lp.path" />
        <span class="lp-path">{{ lp.path }}</span>
        <span class="spacer"></span>
        <div class="lp-actions">
          <button class="btn btn-ghost btn-icon move-btn" title="上移" aria-label="上移" :disabled="i === 0" @click="moveUp(globalPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon move-btn" title="下移" aria-label="下移" :disabled="i === globalPaths.length - 1" @click="moveDown(globalPaths, i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon rm-btn" title="移除" aria-label="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      <!-- 全局目录：添加行 -->
      <div class="lp-add-row">
        <button class="btn btn-secondary btn-md dir-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          选择目录
        </button>
        <UiInput
          v-model="manualGlobalPath"
          placeholder="/absolute/path/to/global-dir"
          :mono="true"
          class="manual-input"
          :error="!!globalPathError"
          @keydown.enter="addGlobalPath"
        />
        <button class="btn btn-default btn-md" @click="addGlobalPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
      </div>
      <div v-if="globalPathError" class="lp-add-error">
        <svg class="lp-add-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{{ globalPathError }}</span>
      </div>
    </section>

    <!-- Layer B：资源预览 -->
    <section class="rp-card">
      <div class="rp-toolbar">
        <span class="rp-title">资源预览</span>
        <span class="rp-count-pill">{{ filteredRp.length }}</span>
        <!-- M10：刷新按钮（secondary dense + RefreshCw · scanning 时 spin + 「刷新中」+ disabled） -->
        <button class="btn btn-secondary btn-dense rp-refresh" :disabled="scanning" @click="refresh">
          <svg class="rp-refresh-icon" :class="{ spin: scanning }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {{ scanning ? '刷新中' : '刷新' }}
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

      <!-- M10：扫描中骨架（3 行 shimmer） -->
      <div v-if="scanning" class="rp-skeleton">
        <div v-for="i in 3" :key="i" class="rp-skel-row">
          <span class="rp-skel-name"></span>
          <span class="rp-skel-badge"></span>
          <span class="rp-skel-desc"></span>
        </div>
      </div>
      <template v-else>
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
        </div>

        <!-- M10：空态三要素（图标 28px neutral-faint + 说明 + Primary 刷新）；区分全空 / 筛选空 -->
        <div v-if="filteredRp.length === 0" class="rp-empty">
          <template v-if="rpItems.length === 0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
            <span class="rp-empty-text">未发现任何 Skill</span>
            <span class="rp-empty-hint">勾选加载路径中的目录，或刷新重新扫描</span>
            <button class="btn btn-secondary btn-dense" :disabled="scanning" @click="refresh">
              <svg :class="{ spin: scanning }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              刷新
            </button>
          </template>
          <template v-else>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <span class="rp-empty-text">{{ SOURCE_LABEL[sourceTab] }} 来源下暂无 Skill</span>
            <span class="rp-empty-hint">切换到「全部」查看其他来源，或导入其他目录</span>
          </template>
        </div>
      </template>
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
.lp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 44px;
}
.lp-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.lp-hint {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  margin-left: auto;
}
.spacer {
  flex: 1;
}

/* M1/M2：分组头（项目 / 全局两组，spec §1） */
.lp-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--surface-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.lp-group-head:first-child {
  border-top: 0;
}
.lp-group-name {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--neutral-fg);
}
.lp-group-scope {
  height: 18px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.lp-group-scope.project {
  background: var(--accent-soft);
  color: var(--accent);
}
.lp-group-scope.global {
  background: var(--surface);
  color: var(--neutral-mid);
}
.lp-group-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  margin-left: auto;
  font-family: var(--font-mono);
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
/* M11：系统锁定态（disabled + lock 图标，spec 三态：checked / disabled+lock） */
.lp-check:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.lp-check:disabled:checked {
  background: var(--accent);
  border-color: var(--accent);
  opacity: 0.55;
}
.lp-lock {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  margin-left: calc(-1 * var(--space-1));
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
.lp-path.forced {
  opacity: 0.55;
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
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.lp-tag.forced {
  background: var(--surface-2);
  color: var(--neutral-dim);
}
.lp-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease);
}
.lp-row:hover .lp-actions,
.lp-row:focus-within .lp-actions {
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

/* M4 添加路径错误文案（spec §3：neutral-mid 配 AlertCircle 12px danger） */
.lp-add-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--space-4) var(--space-3);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.lp-add-error__icon {
  width: 12px;
  height: 12px;
  color: var(--danger);
  flex-shrink: 0;
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
  font-size: var(--text-sm);
}
.rp-refresh:hover {
  color: var(--neutral-fg);
}
.rp-refresh-icon {
  width: 16px;
  height: 16px;
}
.rp-refresh-icon.spin {
  animation: spin 0.9s linear infinite;
}
/* M10 骨架行：shimmer（surface-2 → surface-hover）· name 140px + badge 60px + desc flex:1 */
.rp-skeleton {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.rp-skel-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.rp-skel-name {
  width: 140px;
  height: 12px;
  border-radius: 4px;
  background: var(--surface-2);
  flex-shrink: 0;
}
.rp-skel-badge {
  width: 60px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  flex-shrink: 0;
}
.rp-skel-desc {
  flex: 1;
  height: 12px;
  border-radius: 4px;
  background: var(--surface-2);
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
/* M10：空态（图标 28px neutral-faint + 主文 + 辅文 + Primary 刷新） */
.rp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  text-align: center;
}
.rp-empty svg {
  width: 28px;
  height: 28px;
  color: var(--neutral-faint);
}
.rp-empty-text {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  margin-top: var(--space-1);
}
.rp-empty-hint {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.rp-empty .btn {
  margin-top: var(--space-1);
}
</style>
