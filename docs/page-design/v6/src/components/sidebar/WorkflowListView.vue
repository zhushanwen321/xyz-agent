<script setup lang="ts">
/** WorkflowListView：从 mock workflows 渲染工作流卡片。
 *  v6（spec §7）：进度条仅 running=accent，done=neutral-dim（降中性），
 *  failed=danger，paused=warn；卡片无 border。
 *  每卡片：Workflow icon + name + slug + 进度条 + phase/agent 计数。 */

import { workflows, type WorkflowItem } from '@/mock/sessions'

type Status = WorkflowItem['status']

function fillClass(s: Status) {
  return `is-${s}`
}
function dotClass(s: Status) {
  return `is-${s}`
}
</script>

<template>
  <div class="wf-list">
    <div
      v-for="wf in workflows"
      :key="wf.id"
      class="wf-card"
      role="button"
      tabindex="0"
    >
      <div class="wf-card__row">
        <!-- 状态指示：running=spinner / 其他=圆点 -->
        <svg
          v-if="wf.status === 'running'"
          class="wf-card__spinner"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        <span
          v-else
          class="wf-card__dot"
          :class="dotClass(wf.status)"
        ></span>

        <!-- Workflow icon -->
        <svg
          class="wf-card__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="6" height="6" />
          <rect x="15" y="15" width="6" height="6" />
          <path d="M9 6h6a2 2 0 0 1 2 2v7" />
        </svg>

        <!-- name + slug -->
        <span class="wf-card__name">{{ wf.name }}</span>
        <span class="wf-card__slug">{{ wf.slug }}</span>
      </div>

      <!-- 进度条 + phase/agent 计数 -->
      <div class="wf-card__prog">
        <div class="wf-card__pb">
          <div
            class="wf-card__pb-fill"
            :class="fillClass(wf.status)"
            :style="{ width: `${wf.progress}%` }"
          ></div>
        </div>
        <span class="wf-card__meta">{{ wf.progress }}%</span>
        <span class="wf-card__meta">{{ wf.phaseCount }} phases · {{ wf.agentCount }} agents</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}
.wf-card {
  position: relative;
  padding: 6px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.wf-card:hover {
  background: var(--surface-hover);
}
.wf-card__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wf-card__spinner {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
  animation: spin 1.4s linear infinite;
}
.wf-card__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wf-card__dot.is-running {
  background: var(--accent);
}
.wf-card__dot.is-done {
  background: var(--success);
}
.wf-card__dot.is-failed {
  background: var(--danger);
}
.wf-card__dot.is-paused {
  background: var(--warn);
}
.wf-card__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--neutral-mid);
}
.wf-card__name {
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
.wf-card__slug {
  flex-shrink: 0;
  margin-right: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
}

/* 进度条 + 计数 */
.wf-card__prog {
  margin-top: 4px;
  padding-left: 21px; /* 对齐 name（spinner/dot 7 + icon 14 + gaps） */
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}
.wf-card__pb {
  height: 3px;
  min-width: 40px;
  flex: 1;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border);
}
.wf-card__pb-fill {
  height: 100%;
  border-radius: 999px;
}
/* v6：仅 running 用 accent，done 降 neutral-dim */
.wf-card__pb-fill.is-running {
  background: var(--accent);
}
.wf-card__pb-fill.is-done {
  background: var(--neutral-dim);
}
.wf-card__pb-fill.is-failed {
  background: var(--danger);
}
.wf-card__pb-fill.is-paused {
  background: var(--warn);
}
.wf-card__meta {
  white-space: nowrap;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .wf-card__spinner {
    animation: none;
  }
}
</style>
