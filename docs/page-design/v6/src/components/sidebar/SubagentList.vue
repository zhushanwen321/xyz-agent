<script setup lang="ts">
/** SubagentList：从 mock subagents 渲染子智能体卡片。
 *  v6（spec §7）：卡片 py 统一 6px · 无 border；
 *  状态：running→spinner / done→success 圆点 / failed→danger / cancelled→dim.5。
 *  每卡片：Bot icon + name + slug + model·thinking + 耗时。 */

import { subagents, type SubagentItem } from '@/mock/sessions'

type Status = SubagentItem['status']

function indicatorClass(s: Status) {
  return `is-${s}`
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
    >
      <div class="sa-card__row">
        <!-- Bot icon -->
        <svg
          class="sa-card__bot"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v4" />
          <line x1="8" y1="16" x2="8" y2="16" />
          <line x1="16" y1="16" x2="16" y2="16" />
        </svg>

        <!-- name + model·thinking -->
        <span class="sa-card__name">{{ sa.name }}</span>
        <span class="sa-card__stats">{{ sa.model }} · thinking {{ sa.thinking }}</span>

        <!-- 状态指示：running=spinner / 其他=圆点 -->
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

        <!-- 耗时 -->
        <span v-if="sa.elapsed" class="sa-card__elapsed">{{ sa.elapsed }}</span>
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
.sa-card__bot {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--neutral-mid);
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
.sa-card__elapsed {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}
.sa-card__slug {
  margin-top: 2px;
  padding-left: 22px; /* 对齐 name（bot icon 14 + gap 8） */
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
