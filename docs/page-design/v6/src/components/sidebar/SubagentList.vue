<script setup lang="ts">
/** SubagentList：从 mock subagents 渲染子智能体卡片。
 *  v6（spec §7）：卡片 py 统一 6px · 无 border；
 *  状态指示在最左：running→spinner / done→success 圆点 / failed→danger / cancelled→dim.5。
 *  每卡片：状态 + name + stats（turns · tokens）+ running cancel。 */

import { ref } from 'vue'
import { subagents, type SubagentItem } from '@/mock/sessions'

type Status = SubagentItem['status']

function indicatorClass(s: Status) {
  return `is-${s}`
}

// running 卡片 cancel 两段式确认（纯 UI 状态）
const hoveredId = ref<string | null>(null)
const pendingCancel = ref<string | null>(null)

function confirmCancel(id: string) {
  pendingCancel.value = id
}
function resetCancel() {
  pendingCancel.value = null
}
</script>

<template>
  <div class="sa-list">
    <div
      v-for="sa in subagents"
      :key="sa.id"
      class="sa-card"
      role="button"
      tabindex="0"
      @mouseenter="hoveredId = sa.id"
      @mouseleave="hoveredId = null; pendingCancel = null"
    >
      <div class="sa-card__row">
        <!-- 状态指示（最左）：running=spinner / 其他=圆点 -->
        <svg
          v-if="sa.status === 'running'"
          class="sa-card__spinner"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        <span v-else class="sa-card__dot" :class="indicatorClass(sa.status)"></span>

        <!-- name + stats（spec §7：turns · tokens） -->
        <span class="sa-card__name">{{ sa.name }}</span>
        <span class="sa-card__stats">{{ sa.turns }} turns · {{ sa.tokens }} tok</span>

        <!-- running cancel 按钮（X ghost，两段式确认） -->
        <div v-if="sa.status === 'running' && (hoveredId === sa.id || pendingCancel === sa.id)" class="sa-card__cancel">
          <template v-if="pendingCancel === sa.id">
            <button
              class="sa-cancel sa-cancel--confirm"
              type="button"
              title="确认取消"
              @click.stop="resetCancel"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          </template>
          <template v-else>
            <button
              class="sa-cancel"
              type="button"
              title="取消任务"
              @click.stop="confirmCancel(sa.id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </template>
        </div>
      </div>

      <!-- slug 任务标识 -->
      <div class="sa-card__slug">{{ sa.slug }}</div>
    </div>
  </div>
</template>

<style scoped>
.sa-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}
.sa-card {
  position: relative;
  padding: 6px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.sa-card:hover {
  background: var(--surface-hover);
}
.sa-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sa-card__name {
  min-width: 0;
  flex: 1;
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-card__stats {
  flex-shrink: 0;
  margin-right: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  white-space: nowrap;
}
.sa-card__spinner {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
  animation: spin 1.4s linear infinite;
}
.sa-card__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sa-card__dot.is-done {
  background: var(--success);
}
.sa-card__dot.is-failed {
  background: var(--danger);
}
.sa-card__dot.is-cancelled {
  background: var(--neutral-dim);
  opacity: 0.5;
}
.sa-card__dot.is-running {
  background: var(--accent);
}
/* running cancel 按钮 */
.sa-card__cancel {
  flex-shrink: 0;
  display: flex;
}
.sa-cancel {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.sa-cancel:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.sa-cancel svg {
  width: 12px;
  height: 12px;
}
/* 两段式确认：实心 danger */
.sa-cancel--confirm {
  background: var(--danger);
  color: var(--danger-fg);
}
.sa-cancel--confirm:hover {
  background: var(--danger);
  color: var(--danger-fg);
}
.sa-card__slug {
  margin-top: 2px;
  padding-left: 21px; /* 对齐 name（spinner 13/dot 7 + gap 8） */
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.3;
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sa-card__spinner {
    animation: none;
  }
}
</style>
