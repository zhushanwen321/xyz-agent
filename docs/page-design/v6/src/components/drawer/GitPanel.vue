<script setup lang="ts">
/**
 * GitPanel · git 状态面板
 * 从 mock gitFiles 渲染：gp-head（分支按钮 + dirty pill + stats + refresh）
 * + gp-filelist（checkbox + badge + 文件名 + ±行数）+ commit input + gp-actions
 * pill 纯色文字（语义靠字色），badge 统一 neutral-dim 仅 U 留 danger
 */
import { computed, ref } from 'vue'
import { gitFiles, type GitFile } from '@/mock/sessions'

/** 本地副本（per-file stage toggle 用） */
const files = ref<GitFile[]>(gitFiles.map((f) => ({ ...f })))

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
const branch = ref('feat/v6-drawer')
const branchOpen = ref(false)

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
      <div class="gp-head">
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
          :title="f.name"
        >
          <!-- stage toggle checkbox -->
          <button
            class="gp-stage-toggle"
            :class="f.staged ? 'is-staged' : 'is-unstaged'"
            :title="f.staged ? '取消暂存 unstage(sid,[path])' : '暂存此文件 stage(sid,[path])'"
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
          <span class="gp-filestat">
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
        <button class="gp-act ghost" @click="unstageAll">取消</button>
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

/* 头部 */
.gp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
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
  opacity: 1;
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
  color: var(--neutral-fg);
}
.gp-act.primary:hover {
  background: var(--accent-hover);
}
.gp-act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
