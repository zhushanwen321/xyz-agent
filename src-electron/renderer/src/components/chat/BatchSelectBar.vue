<template>
  <Transition name="batch-bar">
    <div
      v-if="selectedIds.length > 0"
      class="batch-select-bar"
    >
      <span class="batch-select-bar__count">
        已选 {{ selectedIds.length }} 条消息
      </span>
      <div class="batch-select-bar__actions">
        <!-- eslint-disable-next-line taste/no-native-html-elements -- compact action buttons matching existing toast/action-menu style -->
        <button
          class="batch-select-bar__btn"
          @click="$emit('copy-markdown')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制 Markdown</span>
        </button>
        <button
          class="batch-select-bar__btn"
          @click="$emit('copy-plain')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制纯文本</span>
        </button>
        <div class="batch-select-bar__divider" />
        <button
          class="batch-select-bar__btn batch-select-bar__btn--cancel"
          @click="$emit('cancel')"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
          <span>取消</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{
  selectedIds: string[]
}>()

defineEmits<{
  cancel: []
  'copy-markdown': []
  'copy-plain': []
}>()
</script>

<style scoped>
.batch-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 14px;
  height: 36px;
  flex-shrink: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg);
  z-index: 20;
}

.batch-select-bar__count {
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
}

.batch-select-bar__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-select-bar__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.batch-select-bar__btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.batch-select-bar__btn--cancel {
  color: var(--muted);
  border-color: transparent;
}
.batch-select-bar__btn--cancel:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.batch-select-bar__divider {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 2px;
}

/* Transition */
.batch-bar-enter-from,
.batch-bar-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
.batch-bar-enter-active,
.batch-bar-leave-active {
  transition: all 0.2s var(--ease);
}
</style>
