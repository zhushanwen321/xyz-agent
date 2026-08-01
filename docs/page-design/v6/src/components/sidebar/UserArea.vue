<script setup lang="ts">
/** 底部用户区：头像（accent 纯色 20px）+ 用户名 + 设置齿轮。
 *  对齐 v6-spec-sidebar.html §8 .usr。 */

import { openSettings } from '@/composables/useStore'

interface Props {
  name?: string
}
withDefaults(defineProps<Props>(), { name: 'Developer' })
</script>

<template>
  <div class="user-area">
    <span class="user-area__avatar" aria-hidden="true"></span>
    <span class="user-area__name">{{ name }}</span>
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
</style>
