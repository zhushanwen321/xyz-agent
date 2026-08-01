<script setup lang="ts">
/** UserBubble · 用户消息气泡（v6 spec-input §8）
 *  - bg-surface-hover + 14-14-4-14 不对称圆角，无 border
 *  - wrap 720 居中，气泡内右浮 max-w 76%
 *  - hover 显 copy/edit action（demo 常驻显出，placeholder 不占 action 位） */
defineProps<{ message: string }>()
</script>

<template>
  <div class="ub-wrap">
    <div class="ub">
      <span class="ub-text">{{ message }}</span>
      <div class="ub-actions">
        <button class="ub-action" title="复制">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="ub-action" title="编辑">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ub-wrap {
  display: flex;
  justify-content: flex-end;
  max-width: var(--content-max-w);
  width: 100%;
  margin: 0 auto;
}
.ub {
  position: relative;
  display: inline-block;
  max-width: 76%;
  padding: 9px 13px;
  border-radius: 14px 14px 4px 14px;
  background: var(--surface-hover);
  transition: background var(--duration-fast) var(--ease);
}
.ub-text {
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.ub-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease);
}
.ub:hover .ub-actions { opacity: 1; }
.ub-action {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.ub-action svg { width: 13px; height: 13px; }
.ub-action:hover { background: var(--surface); color: var(--neutral-fg); }
</style>
