<script setup lang="ts">
import { ref, nextTick, watch, onBeforeUnmount } from 'vue'
import GroupCard from './GroupCard.vue'
import UiInput from './UiInput.vue'

/**
 * ScanDirsSection：扫描目录管理（spec §9 discovery.json 三数组模型）。
 * SegmentedTab 切 extension/skill/agent 三组，每组双分组：项目目录（相对路径）/ 全局目录（绝对路径）。
 * preset 锁定行（checkbox disabled + lock + 来源 pill）不可移不可关；
 * 用户行 Checkbox 启用/禁用（不加载但保留配置）+ ↑↓ 同组内调优先级 + 移除（两段式确认 cd 范式）。
 * 添加校验链：非空 → 格式（绝对 ^(/|~/) 或相对 ^(\./|[^/])）→ 去重，按路径性质自动归类落组。
 */
type DirTab = 'extension' | 'skill' | 'agent'
type GroupKey = 'project' | 'global'

interface ScanDir {
  id: string
  path: string
  enabled: boolean
  /** preset 锁定目录：不可关/不可移/不可排序；显示来源 pill */
  presetLabel?: string
}
type DirGroup = Record<GroupKey, ScanDir[]>

const DIR_TABS: { id: DirTab; label: string }[] = [
  { id: 'extension', label: 'Extension' },
  { id: 'skill', label: 'Skill' },
  { id: 'agent', label: 'Agent' },
]

const dirTab = ref<DirTab>('extension')
const dirs = ref<Record<DirTab, DirGroup>>({
  extension: {
    project: [
      { id: 'de-1', path: '.pi/extensions', enabled: true, presetLabel: 'pi 原生' },
      { id: 'de-2', path: '.xyz-agent/extensions', enabled: true, presetLabel: '强制结构' },
      { id: 'de-3', path: './local-extensions', enabled: true },
    ],
    global: [
      { id: 'de-4', path: '~/.pi/agent/extensions', enabled: true, presetLabel: 'pi 原生' },
      { id: 'de-5', path: '~/lib/company-extensions', enabled: true },
      { id: 'de-6', path: '~/experiments/dev-extensions', enabled: false },
    ],
  },
  skill: {
    project: [
      { id: 'ds-1', path: '.agents/skills', enabled: true, presetLabel: '强制结构' },
      { id: 'ds-2', path: './local-skills', enabled: true },
    ],
    global: [{ id: 'ds-3', path: '~/work/shared-skills', enabled: true }],
  },
  agent: {
    project: [
      { id: 'da-1', path: '.agents/agents', enabled: true, presetLabel: '强制结构' },
      { id: 'da-2', path: './local-agents', enabled: true },
    ],
    global: [{ id: 'da-3', path: '~/lib/company-agents', enabled: true }],
  },
})

const GROUP_META: Record<GroupKey, { title: string; scope: string; aux: string; addPh: string }> = {
  project: {
    title: '项目目录',
    scope: '仅当前项目',
    aux: '相对路径 · extensionDirs 中相对路径项',
    addPh: '.relative/path/to/project-dir',
  },
  global: {
    title: '全局目录',
    scope: '所有项目共享',
    aux: '绝对路径 · extensionDirs 中绝对路径项',
    addPh: '~/absolute/path/to/global-dir',
  },
}

/** 校验链（spec §9.2）：非空 → 格式（绝对 ^(/|~/) 或相对 ^(./|xx/..) 且无空格）→ 去重 */
const ABS_RE = /^(\/|~\/)/
const REL_RE = /^(\.\/|[^/\s][^\s]*\/)/
const addValue = ref<Record<GroupKey, string>>({ project: '', global: '' })
const addError = ref<Record<GroupKey, string>>({ project: '', global: '' })

function addDir(g: GroupKey) {
  const v = addValue.value[g].trim()
  const err = addError.value
  err[g] = ''
  if (!v) return
  const list = dirs.value[dirTab.value][g]
  if (!ABS_RE.test(v) && !REL_RE.test(v)) {
    err[g] =
      '路径格式不合法：需为绝对路径（如 /Users/... 或 ~/... → 全局）或相对路径（如 .pi/extensions → 项目）'
    return
  }
  if (list.some((d) => d.path === v)) {
    err[g] = `路径已存在：${v} 已在列表中`
    return
  }
  list.push({ id: 'd-' + Date.now(), path: v, enabled: true })
  addValue.value[g] = ''
}

/** 「选择目录」mock：点击填入示例路径（演示绝对/相对自动归类） */
let pickCount = 0
const PICK_SAMPLES: { path: string; group: GroupKey }[] = [
  { path: './team-extensions', group: 'project' },
  { path: '~/team-shared-extensions', group: 'global' },
  { path: '~/lib/design-tools', group: 'global' },
]
function pickDir() {
  const s = PICK_SAMPLES[pickCount++ % PICK_SAMPLES.length]
  addValue.value[s.group] = s.path
  addError.value[s.group] = ''
}

/** ↑↓：同组内相邻同类项交换（preset 锁定行不参与），被移行 accent-soft 微染 120ms */
const movingId = ref('')
let moveTimer: ReturnType<typeof setTimeout> | undefined
function flashMoving(id: string) {
  movingId.value = id
  clearTimeout(moveTimer)
  moveTimer = setTimeout(() => (movingId.value = ''), 120)
}
function canMoveUp(g: GroupKey, i: number) {
  const list = dirs.value[dirTab.value][g]
  return i > 0 && !list[i].presetLabel && !list[i - 1].presetLabel
}
function canMoveDown(g: GroupKey, i: number) {
  const list = dirs.value[dirTab.value][g]
  return i < list.length - 1 && !list[i].presetLabel && !list[i + 1].presetLabel
}
function moveUp(g: GroupKey, i: number) {
  const list = dirs.value[dirTab.value][g]
  if (!canMoveUp(g, i)) return
  ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
  // 交换后 list[i-1] 是被移动的行（spec：高亮被移动者，非被挤开者）
  flashMoving(list[i - 1].id)
}
function moveDown(g: GroupKey, i: number) {
  const list = dirs.value[dirTab.value][g]
  if (!canMoveDown(g, i)) return
  ;[list[i + 1], list[i]] = [list[i], list[i + 1]]
  // 交换后 list[i] 是被移动的行
  flashMoving(list[i].id)
}

/** 移除两段式确认（spec §9.2 沿用 §6 ConfirmDialog 范式；preset 无移除按钮不进此流） */
const removeTarget = ref<{ list: ScanDir[]; dir: ScanDir } | null>(null)
const cdBackdropEl = ref<HTMLElement | null>(null)
watch(removeTarget, (v) => {
  if (v) void nextTick(() => cdBackdropEl.value?.focus())
})
function confirmRemove() {
  const t = removeTarget.value
  if (!t) return
  const i = t.list.findIndex((d) => d.id === t.dir.id)
  if (i >= 0) t.list.splice(i, 1)
  removeTarget.value = null
}

onBeforeUnmount(() => clearTimeout(moveTimer))
</script>

<template>
  <div class="scan-section">
    <GroupCard>
      <template #head>
        <span class="g-title">扫描目录</span>
        <span class="g-aux">靠前 = 高优先级 · 数组顺序统一排序</span>
      </template>

      <!-- SegmentedTab：extension / skill / agent（spec §9：bg-bg-input 容器 + active bg-bg-elevated） -->
      <div class="seg-tabs">
        <button
          v-for="t in DIR_TABS"
          :key="t.id"
          class="seg-tab"
          :class="{ active: dirTab === t.id }"
          @click="dirTab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 双分组（项目目录 / 全局目录） -->
      <div v-for="g in (['project', 'global'] as GroupKey[])" :key="g" class="scan-group">
        <div class="scan-group-head">
          <span class="sg-title">{{ GROUP_META[g].title }}</span>
          <span class="sg-scope" :class="g">{{ GROUP_META[g].scope }}</span>
          <span class="sg-aux">{{ GROUP_META[g].aux }}</span>
        </div>

        <!-- preset 锁定行：disabled checkbox + lock + 来源 pill，无操作 -->
        <div v-for="(d, i) in dirs[dirTab][g]" :key="d.id" class="scan-row" :class="{ moving: movingId === d.id }">
          <button v-if="!d.presetLabel" role="checkbox" :aria-checked="d.enabled" class="ui-checkbox" :class="{ checked: d.enabled }" @click="d.enabled = !d.enabled">
            <svg v-if="d.enabled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </button>
          <span v-else role="checkbox" aria-checked="true" aria-disabled="true" class="ui-checkbox checked disabled">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </span>
          <span class="scan-path" :class="{ forced: d.presetLabel }">{{ d.path }}</span>
          <svg v-if="d.presetLabel" class="scan-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span v-if="d.presetLabel" class="sg-scope preset">{{ d.presetLabel }}</span>
          <span v-else class="scan-actions">
            <button class="btn btn-ghost btn-icon-sm" :disabled="!canMoveUp(g, i)" title="上移" aria-label="上移" @click="moveUp(g, i)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon-sm" :disabled="!canMoveDown(g, i)" title="下移" aria-label="下移" @click="moveDown(g, i)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button class="btn btn-danger btn-icon-sm" title="移除" aria-label="移除" @click="removeTarget = { list: dirs[dirTab][g], dir: d }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </span>
        </div>

        <!-- 添加行（双方式：目录选择 + 手动填写，spec §9.1） -->
        <div class="scan-add-row">
          <UiInput
            v-model="addValue[g]"
            :placeholder="GROUP_META[g].addPh"
            :mono="true"
            :dense="true"
            :error="!!addError[g]"
            @keyup.enter="addDir(g)"
          />
          <button class="btn btn-secondary btn-dense" title="选择目录" @click="pickDir">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
            选择目录
          </button>
          <button class="btn btn-default btn-dense" @click="addDir(g)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            添加
          </button>
        </div>
        <!-- 添加错误（spec §9.2：Input border-danger + 下方 danger 文案「原因 + 下一步」） -->
        <div v-if="addError[g]" class="scan-err">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          <span>{{ addError[g] }}</span>
        </div>
      </div>
    </GroupCard>

    <!-- 移除确认（spec §6/§9.2 ConfirmDialog 范式：bg-surface + border + shadow-2 + radius-lg） -->
    <div v-if="removeTarget" ref="cdBackdropEl" tabindex="-1" class="cd-backdrop" @click.self="removeTarget = null" @keydown.esc="removeTarget = null">
      <div class="cd">
        <div class="cd-header">
          <div class="cd-title-row">
            <svg class="cd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="cd-title">移除目录 <span class="cd-target">{{ removeTarget.dir.path }}</span>？</span>
          </div>
        </div>
        <p class="cd-desc">将从 <code class="cd-code">discovery.json</code> 的对应数组移除该目录，新会话不再扫描其下扩展。此操作不可撤销。</p>
        <div class="cd-acts">
          <button class="btn btn-ghost btn-dense" @click="removeTarget = null">取消</button>
          <button class="btn btn-danger btn-dense" @click="confirmRemove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            移除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scan-section {
  margin-top: var(--space-4);
}
.g-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.g-aux {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
}

/* SegmentedTab（spec §9：bg-bg-input 容器 · p-[3px] · active bg-bg-elevated） */
.seg-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  margin: 2px 4px 8px;
}
.seg-tab {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  transition: background var(--duration-fast), color var(--duration-fast);
  white-space: nowrap;
}
.seg-tab:hover {
  color: var(--neutral-fg);
}
.seg-tab.active {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}

/* 分组头（spec §9.1：bg-surface-2 浮起分层，不嵌套卡片） */
.scan-group {
  margin-top: 4px;
}
.scan-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  margin: 6px 4px;
}
.sg-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.sg-scope {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.sg-scope.project {
  background: var(--accent-soft);
  color: var(--accent);
}
.sg-scope.global {
  background: var(--surface);
  color: var(--neutral-mid);
}
.sg-scope.preset {
  background: var(--surface-2);
  color: var(--neutral-dim);
}
.sg-aux {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
}

/* 列表行（spec §9.1：flex · hairline 分行 · hover 显操作组） */
.scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  font-size: var(--text-sm);
  transition: background var(--duration-fast);
}
.scan-row.moving {
  background: var(--accent-soft);
}
.scan-lock {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.scan-path {
  font-family: var(--font-mono);
  color: var(--neutral-fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}
.scan-path.forced {
  opacity: 0.55;
}
.scan-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--duration-fast);
}
.scan-row:hover .scan-actions,
.scan-row:focus-within .scan-actions {
  opacity: 1;
}
.scan-actions :deep(.btn-icon-sm) {
  color: var(--neutral-dim);
}
.scan-actions :deep(.btn-icon-sm:hover) {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.scan-actions :deep(.btn-danger.btn-icon-sm:hover) {
  color: var(--danger);
}

/* 添加行（spec §9.1：双方式：目录选择 + 手动填写） */
.scan-add-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  flex-wrap: wrap;
}
.scan-add-row :deep(.ui-input) {
  flex: 1;
  min-width: 180px;
}
.scan-err {
  font-size: var(--text-xs);
  color: var(--danger);
  padding: 4px 16px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.scan-err svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

/* Checkbox（spec §7：16×16 · radius-sm · checked bg-accent 白勾 · disabled opacity .5） */
.ui-checkbox {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  color: #fff;
  padding: 0;
  transition: background var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease);
}
.ui-checkbox.checked {
  background: var(--accent);
  border-color: var(--accent);
}
.ui-checkbox.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ui-checkbox svg {
  width: 11px;
  height: 11px;
}

/* 移除确认（spec §6 ConfirmDialog SSOT：bg-surface + border + shadow-2 + radius-lg 12px） */
.cd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
}
.cd {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  width: 100%;
  max-width: 360px;
  padding: 24px;
}
.cd-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cd-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cd-ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--danger);
}
.cd-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--neutral-fg);
}
.cd-target {
  font-family: var(--font-mono);
  color: var(--neutral-fg);
}
.cd-code {
  font-family: var(--font-mono);
  color: var(--neutral-fg);
}
.cd-desc {
  font-size: 13px;
  color: var(--neutral-mid);
  line-height: 1.55;
  margin-top: 4px;
  margin-bottom: 20px;
}
.cd-acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
</style>
