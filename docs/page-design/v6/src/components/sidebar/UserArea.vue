<script setup lang="ts">
/** 底部用户区：头像（accent 纯色 20px）+ 用户名 + 设置齿轮 + overlay 测试入口。
 *  对齐 v6-spec-sidebar.html §8 .usr。 */

import { openSettings, openAskUser, openConfirm } from '@/composables/useStore'

interface Props {
  name?: string
}
withDefaults(defineProps<Props>(), { name: 'user' })
</script>

<template>
  <div class="user-area">
    <span class="user-area__avatar" aria-hidden="true"></span>
    <span class="user-area__name">{{ name }}</span>
    <!-- overlay 测试入口（demo 触发 AskUser / Confirm，调试用途） -->
    <button
      class="user-area__test"
      type="button"
      title="测试 · AskUser 覆盖层"
      aria-label="打开 AskUser 覆盖层（测试）"
      @click="openAskUser()"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </button>
    <button
      class="user-area__test"
      type="button"
      title="测试 · Confirm 确认框"
      aria-label="打开 Confirm 确认框（测试）"
      @click="openConfirm()"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </button>
    <button
      class="user-area__settings"
      type="button"
      title="设置"
      aria-label="打开设置"
      @click="openSettings()"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.user-area {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.user-area__avatar {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent); /* v6：纯色，去装饰渐变 */
}
.user-area__name {
  flex: 1;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-area__settings {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--neutral-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.user-area__settings:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.user-area__settings svg {
  width: 14px;
  height: 14px;
}
/* overlay 测试入口：调试用途，更不显眼（opacity 0.5，hover 恢复） */
.user-area__test {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--neutral-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
  opacity: 0.5;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease),
    opacity var(--duration-fast) var(--ease);
}
.user-area__test:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
  opacity: 1;
}
.user-area__test svg {
  width: 14px;
  height: 14px;
}
</style>
