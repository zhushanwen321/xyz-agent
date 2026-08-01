<script setup lang="ts">
/** WorkflowDetail：workflow 详情视图（spec §7 视图 2）。
 *  从 WorkflowListView 点击卡片进入：返回按钮 + workflow 名 + slug +
 *  pause/resume + abort + 分隔线 + agent call 行列表（状态点 + call 名 + sessionId + 跳转 link）。
 *  样式对齐 spec .wfd-*：header ghost 按钮（hover→bg-surface-hover）/ danger 语义（hover→bg-danger-soft）。 */

import { ref } from 'vue'
import type { WorkflowItem } from '@/mock/sessions'

const props = defineProps<{ workflow: WorkflowItem }>()

const emit = defineEmits<{ (e: 'back'): void }>()

/** 暂停/继续（纯 UI 状态：running→暂停按钮，paused→继续按钮）。
 *  进入详情必经列表视图（v-if 重挂载），初始值从 props 取一次即可。 */
const paused = ref(props.workflow.status === 'paused')

function onTogglePause() {
  paused.value = !paused.value
}

function callDotClass(status: string) {
  return `is-${status}`
}
</script>

<template>
  <div class="wfd">
    <!-- header：返回 + name + slug + pause/resume + abort -->
    <div class="wfd__head">
      <button class="wfd__back" type="button" title="返回列表" aria-label="返回列表" @click="emit('back')">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <span class="wfd__name">
        {{ workflow.name }}
        <span class="wfd__slug">{{ workflow.slug }}</span>
      </span>
      <button
        class="wfd__btn"
        type="button"
        :title="paused ? '继续' : '暂停'"
        @click="onTogglePause"
      >
        <svg
          v-if="paused"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
        <span>{{ paused ? '继续' : '暂停' }}</span>
      </button>
      <button
        class="wfd__btn wfd__btn--danger"
        type="button"
        title="终止"
        aria-label="终止工作流"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      </button>
    </div>

    <div class="wfd__hr"></div>

    <!-- agent call 行列表 -->
    <div
      v-for="call in workflow.calls"
      :key="call.id"
      class="wfd__call"
      role="button"
      tabindex="0"
      :title="`跳转到会话 ${call.sessionId}`"
    >
      <span class="wfd__cdot" :class="callDotClass(call.status)"></span>
      <span class="wfd__cname">{{ call.name }}</span>
      <span class="wfd__csid">{{ call.sessionId }}</span>
      <span class="wfd__link">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M7 7h10v10" />
          <path d="M7 17 17 7" />
        </svg>
      </span>
    </div>
  </div>
</template>

<style scoped>
.wfd {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 4px;
}
.wfd__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
}
.wfd__back {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
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
.wfd__back:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.wfd__back svg {
  width: 15px;
  height: 15px;
}
.wfd__name {
  min-width: 0;
  flex: 1;
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wfd__slug {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 400;
  color: var(--neutral-dim);
  margin-left: 6px;
}
/* 操作按钮：ghost 语义 + danger 语义（对齐 SSOT §6.1） */
.wfd__btn {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  background: transparent;
  border: 0;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.wfd__btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.wfd__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.wfd__btn svg {
  width: 12px;
  height: 12px;
}
.wfd__btn--danger {
  color: var(--danger);
}
.wfd__btn--danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.wfd__hr {
  height: 1px;
  background: var(--border);
  margin: 2px 4px;
}
/* agent call 行 */
.wfd__call {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.wfd__call:hover {
  background: var(--surface-hover);
}
.wfd__cdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wfd__cdot.is-running {
  background: var(--accent);
  animation: pulse-accent 1.8s ease-in-out infinite;
}
.wfd__cdot.is-done {
  background: var(--success);
}
.wfd__cdot.is-failed {
  background: var(--danger);
}
.wfd__cname {
  min-width: 0;
  flex: 1;
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wfd__csid {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}
.wfd__link {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: var(--neutral-dim);
}
.wfd__link svg {
  width: 12px;
  height: 12px;
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
  .wfd__cdot.is-running {
    animation: none;
  }
}
</style>
