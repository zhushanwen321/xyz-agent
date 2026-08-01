<script setup lang="ts">
/** ForkGroup：当前 session 的后台分支小列表（spec §5）。
 *  v6：去嵌套卡片（无 border 无 accent/5 染底），缩进 + 折叠头 accent 文字；
 *  「分支 N」pill 降 neutral-dim 无底色；stop 两段式确认去 border 仅 bg-danger。
 *  挂载：SessionList 当前 session 项下方。 */

import { ref } from 'vue'

type ForkStatus = 'running' | 'done' | 'error' | 'stopped'

interface ForkBranch {
  id: string
  label: string
  status: ForkStatus
  /** 「分支 N」序号（pill） */
  index: number
  time: string
  /** 未读：状态点右上 accent ring（spec §5 .fg-dot.unread-ring） */
  unread?: boolean
  /** fresh 高亮：bg-accent-soft + inset ring（spec §5 .fg-item.fresh） */
  fresh?: boolean
}

/** demo 数据：静态分支列表（2-3 条，覆盖 running/done/fresh 态） */
const branches: ForkBranch[] = [
  { id: 'fork-1', label: '探索 API 设计', status: 'running', index: 1, time: '2m' },
  { id: 'fork-2', label: '尝试性能优化', status: 'done', index: 2, time: '1h' },
  { id: 'fork-3', label: '新 fork 分支', status: 'done', index: 3, time: 'just now', unread: true, fresh: true },
]

/** 折叠/展开 */
const expanded = ref(true)

/** stop 两段式确认（纯 UI 状态） */
const pendingStop = ref<string | null>(null)

function confirmStop(id: string) {
  pendingStop.value = id
}
function resetStop() {
  pendingStop.value = null
}

function dotClass(status: ForkStatus) {
  return `is-${status}`
}
</script>

<template>
  <div class="fg">
    <!-- 折叠头：chev（旋转态）+ GitFork + accent 标题 + 分支数 -->
    <div
      class="fg__head"
      :class="{ 'fg__head--collapsed': !expanded }"
      role="button"
      tabindex="0"
      @click="expanded = !expanded"
      @keydown.enter="expanded = !expanded"
    >
      <svg
        class="fg__chev"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <svg
        class="fg__fork"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="5" r="2" />
        <path d="M7 12a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2" />
        <path d="M17 12a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2" />
        <path d="M12 7v0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2" />
      </svg>
      <span class="fg__title">本会话的分支</span>
      <span class="fg__count">{{ branches.length }}</span>
    </div>

    <!-- 分支行列表 -->
    <div v-if="expanded" class="fg__list">
      <div
        v-for="b in branches"
        :key="b.id"
        class="fg__item"
        :class="{ 'fg__item--fresh': b.fresh }"
        role="button"
        tabindex="0"
      >
        <!-- 状态点 + 未读 ring -->
        <span class="fg__dot-wrap">
          <span class="fg__dot" :class="dotClass(b.status)"></span>
          <span v-if="b.unread" class="fg__dot-unread"></span>
        </span>

        <!-- 分支名 + meta（pill + 时间） -->
        <span class="fg__main">
          <span class="fg__label">{{ b.label }}</span>
          <span class="fg__meta">
            <span class="fg__pill">分支 {{ b.index }}</span>
            <span class="fg__time">{{ b.time }}</span>
          </span>
        </span>

        <!-- stop：仅 running 可停（两段式确认，仅 bg-danger） -->
        <span v-if="b.status === 'running'" class="fg__stop-slot">
          <button
            v-if="pendingStop === b.id"
            class="fg__stop fg__stop--confirm"
            type="button"
            title="确认停止"
            @click.stop="resetStop"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          <button
            v-else
            class="fg__stop"
            type="button"
            title="停止分支"
            @click.stop="confirmStop(b.id)"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 容器：缩进表达层级，无 border 无染底（spec §5） */
.fg {
  margin: 2px 4px 4px;
  padding-left: 8px;
}
/* 折叠头 */
.fg__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease);
}
.fg__head:hover {
  background: var(--surface-hover);
}
.fg__head svg {
  width: 11px;
  height: 11px;
  color: var(--accent);
  flex-shrink: 0;
}
.fg__chev {
  transition: transform var(--duration-fast) var(--ease);
}
/* 展开：chev 旋转 90°；折叠：归位 0° */
.fg__head:not(.fg__head--collapsed) .fg__chev {
  transform: rotate(90deg);
}
.fg__title {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--accent);
}
.fg__count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--accent);
  opacity: 0.7;
}
/* 分支行列表 */
.fg__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fg__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.fg__item:hover {
  background: var(--surface-hover);
}
/* fresh 高亮：bg-accent-soft + inset ring（3.2s 淡出，demo 静态呈现） */
.fg__item--fresh {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
}
.fg__dot-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
}
.fg__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.fg__dot.is-running {
  background: var(--accent);
  animation: pulse-accent 1.8s ease-in-out infinite;
}
.fg__dot.is-done {
  background: var(--success);
}
.fg__dot.is-error {
  background: var(--danger);
}
.fg__dot.is-stopped {
  background: var(--neutral-dim);
  opacity: 0.5;
}
/* 未读 ring：状态点右上，accent + ring-bg 隔离 */
.fg__dot-unread {
  position: absolute;
  right: -4px;
  top: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg);
}
.fg__main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.fg__label {
  font-size: var(--text-sm);
  line-height: 1.3;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fg__meta {
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}
/* 「分支 N」pill：neutral-dim 无底色（spec §5 v6） */
.fg__pill {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 1.4;
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
}
.fg__time {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* stop 按钮：ghost 图标，hover→danger-soft；确认态实心 danger（去 border） */
.fg__stop-slot {
  flex-shrink: 0;
  display: flex;
}
.fg__stop {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-mid);
  cursor: pointer;
  background: transparent;
  border: 0;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.fg__stop:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.fg__stop:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.fg__stop svg {
  width: 11px;
  height: 11px;
}
.fg__stop--confirm {
  background: var(--danger);
  color: #fff; /* accent/danger-on 文字色 token 未建立，spec §5 显式 #fff */
}
.fg__stop--confirm:hover {
  background: var(--danger);
  color: #fff;
}
@keyframes pulse-accent {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .fg__dot.is-running {
    animation: none;
  }
}
</style>
