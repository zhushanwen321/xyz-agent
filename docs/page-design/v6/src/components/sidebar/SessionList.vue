<script setup lang="ts">
/** SessionList：按 cwd 分组渲染会话。组标题 sticky（normal-case 11px）。
 *  每个 SessionItem 对齐 v6-spec-sidebar.html §3 全状态矩阵：
 *  active=bg-surface+text-accent；7px 圆点；hover ghost 操作；dead opacity-50。
 *  SessionItem 内联在本文件（state 逻辑紧密，单文件≤400 行可容纳）。 */

import { computed, ref } from 'vue'
import { activeSessionId } from '@/composables/useStore'
import { sessions, type SessionItem } from '@/mock/sessions'

type Status = SessionItem['status']

/** 按 cwd 分组（保持 mock 顺序）。无 cwd 归入「其它」。 */
const groups = computed(() => {
  const map = new Map<string, SessionItem[]>()
  for (const s of sessions) {
    const key = s.cwd || '其它'
    const arr = map.get(key) ?? []
    arr.push(s)
    map.set(key, arr)
  }
  return Array.from(map.entries()).map(([cwd, items]) => ({ cwd, items }))
})

function select(id: string) {
  activeSessionId.value = id
}

/** 状态点 class 映射（spec §3.3） */
function dotClass(status: Status): string {
  return {
    running: 'is-running',
    done: 'is-done',
    waiting: 'is-waiting',
    error: 'is-error',
    dead: 'is-dead',
  }[status]
}

// hover 操作 + 两段式删除确认（纯 UI 状态）
const hoveredId = ref<string | null>(null)
const pendingDelete = ref<string | null>(null)

function confirmDelete(id: string) {
  pendingDelete.value = id
}
function resetDelete() {
  pendingDelete.value = null
}
</script>

<template>
  <div class="session-list">
    <div v-for="grp in groups" :key="grp.cwd" class="session-list__group">
      <!-- 组标题：sticky · normal-case 11px -->
      <div class="group-head">
        <svg
          class="group-head__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
          />
        </svg>
        <span class="group-head__title">{{ grp.cwd }}</span>
        <span class="group-head__count">{{ grp.items.length }}</span>
      </div>

      <!-- 会话项 -->
      <div
        v-for="s in grp.items"
        :key="s.id"
        class="si"
        :class="{
          'si--active': activeSessionId === s.id,
          'si--dead': s.status === 'dead',
        }"
        role="button"
        tabindex="0"
        @click="select(s.id)"
        @keydown.enter="select(s.id)"
        @mouseenter="hoveredId = s.id"
        @mouseleave="hoveredId = null"
      >
        <!-- 状态点 + 未读 badge -->
        <div class="si__status">
          <span class="si__dot" :class="dotClass(s.status)"></span>
          <span v-if="s.unread" class="si__unread"></span>
        </div>

        <!-- 主体：label + sub -->
        <div class="si__main">
          <div class="si__label">{{ s.title }}</div>
          <div class="si__sub" :class="{ 'si__sub--fork': s.forkLineage }">
            <template v-if="s.forkLineage">↑ fork 自 {{ s.forkSource || s.forkLineage }}</template>
            <template v-else>{{ s.branch }}</template>
          </div>
        </div>

        <!-- 耗时 -->
        <span v-if="s.elapsed" class="si__time">{{ s.elapsed }}</span>

        <!-- hover ghost 操作（删除走两段式确认） -->
        <div v-if="hoveredId === s.id || pendingDelete === s.id" class="si__actions">
          <template v-if="pendingDelete === s.id">
            <button
              class="si-act si-act--confirm"
              type="button"
              title="确认删除"
              @click.stop="resetDelete"
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
          </template>
          <template v-else>
            <!-- rename：pencil -->
            <button class="si-act" type="button" title="重命名" @click.stop>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
            </button>
            <!-- archive：archive-box -->
            <button class="si-act" type="button" title="归档" @click.stop>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="2" y="3" width="20" height="5" rx="1" />
                <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
            </button>
            <!-- delete：trash -->
            <button
              class="si-act si-act--danger"
              type="button"
              title="删除"
              @click.stop="confirmDelete(s.id)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                />
              </svg>
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 4px;
}

/* 组标题：sticky · normal-case · 11px · neutral-dim */
.group-head {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 2px;
}
.group-head__icon {
  width: 11px;
  height: 11px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.group-head__title {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--neutral-dim);
  /* v6：normal-case，去 uppercase tracking（spec §4 AI slop tell） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-head__count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  opacity: 0.6;
}

/* SessionItem */
.si {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.si:hover {
  background: var(--surface-hover);
}
/* active：bg-surface 实色块 + text-accent 蓝字，无 ring 无左条（spec §3.2） */
.si--active {
  background: var(--surface);
}
.si--dead {
  opacity: 0.5;
}

.si__status {
  position: relative;
  flex-shrink: 0;
  margin-top: 3px;
}
/* 7px 圆点统一（spec §3.3） */
.si__dot {
  display: block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.si__dot.is-running {
  background: var(--accent);
  animation: pulse-accent 1.8s ease-in-out infinite;
}
.si__dot.is-done {
  background: var(--success);
  opacity: 0.9;
}
.si__dot.is-waiting {
  background: var(--warn);
}
.si__dot.is-error {
  background: var(--danger);
}
.si__dot.is-dead {
  background: var(--neutral-dim);
  opacity: 0.5;
}
/* 未读 badge：7px accent 圆点（spec 状态点左上角） */
.si__unread {
  position: absolute;
  left: -2px;
  top: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.si__main {
  min-width: 0;
  flex: 1;
}
.si__label {
  font-size: var(--text-sm);
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si--active .si__label {
  color: var(--accent);
}
.si__sub {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.3;
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si__sub--fork {
  color: color-mix(in oklch, var(--accent) 80%, transparent);
}
.si__time {
  flex-shrink: 0;
  padding-top: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.35;
  color: var(--neutral-dim);
}

/* hover ghost 操作（spec §3） */
.si__actions {
  position: absolute;
  bottom: 2px;
  right: 4px;
  display: flex;
  gap: 2px;
}
.si-act {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-mid);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.si-act:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.si-act svg {
  width: 13px;
  height: 13px;
}
.si-act--danger {
  color: var(--danger);
}
.si-act--danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
/* 两段式确认：实心 danger */
.si-act--confirm {
  background: var(--danger);
  color: #fff; /* accent/danger-on 文字色 token 未建立，spec §3 显式 #fff */
}
.si-act--confirm:hover {
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
  .si__dot.is-running {
    animation: none;
  }
}
</style>
