<script setup lang="ts">
/**
 * GitPanel · git 状态面板
 * 从 mock gitFiles 渲染：gp-head（分支按钮 + dirty pill + stats + refresh）
 * + gp-filelist（checkbox + badge + 文件名 + ±行数）+ commit input + gp-actions
 * pill 纯色文字（语义靠字色），badge 统一 neutral-dim 仅 U 留 danger
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { gitFiles, type GitFile } from '@/mock/sessions'

/** 本地副本（per-file stage toggle 用） */
const files = ref<GitFile[]>(gitFiles.map((f) => ({ ...f })))

// demo 演示数据：mock 暂无 U（conflict）文件，静态补一行演示冲突态渲染
// （真实数据来自 GIT_STATUS 的 U 条目；mock 更新后删此段）
files.value.push({
  name: 'src/git/merge.ts',
  badge: 'U',
  staged: false,
  add: 0,
  del: 0,
})

/** 累计 stats */
const stats = computed(() => {
  let add = 0
  let del = 0
  for (const f of files.value) {
    add += f.add
    del += f.del
  }
  return { add, del }
})

/** 当前分支 */
const branch = ref('main')
const branchOpen = ref(false)

/** 分支列表（demo 静态数据，勿改 mock；spec §7 MVP-2 getStatus().branches[] 占位） */
const branches = ['main', 'feat/v6-demo', 'fix/drawer-shadow']

/** 切分支：高亮跟随 + 收起 popover */
function selectBranch(name: string) {
  branch.value = name
  branchOpen.value = false
}

/** 点击外部 / Esc 关闭 popover */
const branchBtnRef = ref<HTMLElement | null>(null)
function onDocClick(e: MouseEvent) {
  const el = branchBtnRef.value
  if (el && !el.contains(e.target as Node)) branchOpen.value = false
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') branchOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onEsc)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onEsc)
})

/** commit message */
const commitMsg = ref('')

/** per-file stage toggle */
function toggleStage(f: GitFile) {
  f.staged = !f.staged
}

/** 全部暂存/取消 */
function stageAll() {
  files.value.forEach((f) => (f.staged = true))
}
function unstageAll() {
  files.value.forEach((f) => (f.staged = false))
}
function commit() {
  /* demo 占位 */
}

/** 提交快捷键 Cmd/Ctrl+Enter */
function onCommitKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    commit()
  }
}
</script>

<template>
  <div class="gp-v6">
    <div class="gp-body">
      <!-- 头部：分支按钮 + dirty pill + stats + refresh -->
      <div class="gp-head" ref="branchBtnRef">
        <svg class="gp-branch-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <button
          class="gp-branch-btn"
          :class="{ 'is-open': branchOpen }"
          title="切换分支"
          @click="branchOpen = !branchOpen"
        >
          <span class="gp-branch-name">{{ branch }}</span>
          <svg class="gp-branch-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <!-- BranchSelectPopover（spec §7 MVP-2：绝对定位卡片，当前分支高亮 + 新建分支入口）-->
        <div v-if="branchOpen" class="gp-branch-popover">
          <div class="gp-po-head">branches</div>
          <div
            v-for="b in branches"
            :key="b"
            class="gp-po-item"
            :class="{ 'is-current': b === branch }"
            @click="selectBranch(b)"
          >
            <span class="gp-po-name">{{ b }}</span>
            <svg class="gp-po-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <!-- MVP-3：新建分支入口（accent，占位）-->
          <div class="gp-po-new" title="新建分支 CreateBranchModal">
            <svg class="gp-po-new-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>新建分支</span>
          </div>
        </div>

        <span class="gp-pill dirty" :title="files.length + ' changes'">dirty</span>
        <span class="gp-stats">
          <span class="gp-add">+{{ stats.add }}</span>
          <span class="gp-del">−{{ stats.del }}</span>
        </span>
        <button class="gp-refresh" title="刷新">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      <!-- 文件列表 -->
      <ul class="gp-filelist">
        <li
          v-for="f in files"
          :key="f.name"
          class="gp-file"
          :class="{ 'gp-file--conflict': f.badge === 'U' }"
          :title="f.badge === 'U' ? f.name + '（冲突，需先解决）' : f.name"
        >
          <!-- stage toggle checkbox -->
          <button
            class="gp-stage-toggle"
            :class="f.staged ? 'is-staged' : 'is-unstaged'"
            :title="f.badge === 'U' ? '冲突文件需先解决冲突再暂存' : f.staged ? '取消暂存 unstage(sid,[path])' : '暂存此文件 stage(sid,[path])'"
            :disabled="f.badge === 'U'"
            @click="toggleStage(f)"
          >
            <svg v-if="f.staged" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <span class="gp-badge" :class="f.badge">{{ f.badge }}</span>
          <span class="gp-path">{{ f.name }}</span>
          <span v-if="f.badge !== 'U'" class="gp-filestat">
            <span class="gp-add">+{{ f.add }}</span>
            <span class="gp-del">−{{ f.del }}</span>
          </span>
        </li>
      </ul>

      <!-- commit input -->
      <input
        v-model="commitMsg"
        class="gp-commit-input"
        placeholder="提交信息（Cmd/Ctrl+Enter 提交）"
        @keydown="onCommitKeydown"
      />

      <!-- 操作区 -->
      <div class="gp-actions">
        <button class="gp-act ghost" @click="stageAll">全部暂存</button>
        <button class="gp-act ghost" @click="unstageAll">取消暂存</button>
        <button class="gp-act primary" @click="commit">提交</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gp-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}
.gp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--text-sm);
}

/* 头部（popover 定位锚点） */
.gp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  position: relative;
}
.gp-head .gp-branch-ico {
  width: 12px;
  height: 12px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.gp-branch-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 6px;
  margin-left: -6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.gp-branch-btn:hover,
.gp-branch-btn.is-open {
  background: var(--surface-hover);
}
.gp-branch-btn .gp-branch-name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gp-branch-btn:hover .gp-branch-name,
.gp-branch-btn.is-open .gp-branch-name {
  color: var(--neutral-fg);
}
.gp-branch-btn .gp-branch-chev {
  width: 11px;
  height: 11px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  transition: transform var(--duration-fast) var(--ease);
}
.gp-branch-btn.is-open .gp-branch-chev {
  transform: rotate(180deg);
}

/* BranchSelectPopover（spec §7 MVP-2：bg-bg-elevated + ring-border-strong + shadow-2）*/
.gp-branch-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 2px;
  min-width: 200px;
  max-width: 260px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: 4px;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.gp-branch-popover .gp-po-head {
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  padding: 4px 8px 2px;
  font-family: var(--font-mono);
}
.gp-branch-popover .gp-po-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.gp-branch-popover .gp-po-item:hover {
  background: var(--surface-hover);
}
.gp-branch-popover .gp-po-item.is-current {
  background: var(--accent-soft);
}
.gp-branch-popover .gp-po-item .gp-po-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
}
.gp-branch-popover .gp-po-item .gp-po-check {
  width: 12px;
  height: 12px;
  color: var(--accent);
  flex-shrink: 0;
  opacity: 0;
}
.gp-branch-popover .gp-po-item.is-current .gp-po-check {
  opacity: 1;
}
.gp-branch-popover .gp-po-new {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  margin-top: 2px;
  border-top: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--accent);
  font-size: var(--text-xs);
  transition: background var(--duration-fast) var(--ease);
}
.gp-branch-popover .gp-po-new:hover {
  background: var(--accent-soft);
}
.gp-branch-popover .gp-po-new .gp-po-new-ico {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

/* 纯色文字 pill（语义靠字色） */
.gp-pill {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 500;
  color: var(--warn);
}
.gp-pill.clean,
.gp-pill.staged {
  color: var(--success);
}
.gp-pill.dirty {
  color: var(--warn);
}
.gp-pill.conflict {
  color: var(--danger);
}

.gp-stats {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  display: inline-flex;
  gap: 4px;
}
.gp-stats .gp-add,
.gp-filestat .gp-add {
  color: var(--success);
}
.gp-stats .gp-del,
.gp-filestat .gp-del {
  color: var(--danger);
}

.gp-refresh {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease);
}
.gp-refresh:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

/* 文件列表 */
.gp-filelist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gp-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.gp-file:hover {
  background: var(--surface-hover);
}
/* 冲突态（v6：去 danger 左竖条，改 bg-danger-soft 整块 + rounded，spec §7）*/
.gp-file--conflict,
.gp-file--conflict:hover {
  background: var(--danger-soft);
  border-radius: var(--radius-sm);
}
.gp-file--conflict .gp-stage-toggle {
  opacity: 0;
  cursor: not-allowed;
}
.gp-file .gp-stage-toggle {
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--neutral-dim);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.gp-file:hover .gp-stage-toggle {
  opacity: 1;
}
.gp-file .gp-stage-toggle:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.gp-file .gp-stage-toggle.is-staged {
  color: var(--success);
}
.gp-file .gp-stage-toggle.is-unstaged {
  color: var(--neutral-mid);
}
.gp-file .gp-stage-toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}

.gp-file .gp-badge {
  width: 14px;
  flex-shrink: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--neutral-dim);
}
.gp-file .gp-badge.U {
  color: var(--danger);
  font-weight: 700;
}

.gp-file .gp-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--neutral-mid);
  font-size: var(--text-xs);
}
.gp-file:hover .gp-path {
  color: var(--neutral-fg);
}
.gp-filestat {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  display: inline-flex;
  gap: 4px;
}

/* commit input */
.gp-commit-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  background: var(--bg-input);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--neutral-fg);
  font-size: var(--text-xs);
  font-family: inherit;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease);
}
.gp-commit-input::placeholder {
  color: var(--neutral-dim);
}
.gp-commit-input:focus {
  border-color: var(--accent-ring);
}

/* 操作区 */
.gp-actions {
  display: flex;
  gap: 6px;
}
.gp-act {
  flex: 1;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  font-size: var(--text-xs);
  font-family: inherit;
  padding: 0 8px;
  transition: all var(--duration-fast) var(--ease);
}
.gp-act.ghost {
  background: transparent;
  color: var(--neutral-fg);
}
.gp-act.ghost:hover {
  background: var(--surface-hover);
}
.gp-act.primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.gp-act.primary:hover {
  background: var(--accent-hover);
}
.gp-act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
