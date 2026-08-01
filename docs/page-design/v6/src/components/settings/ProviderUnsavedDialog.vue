<script setup lang="ts">
import { onMounted, ref } from 'vue'

/** M2 未保存保护 ConfirmDialog（spec §3 AlertDialog 样式）。
 * 焦点初始在「继续编辑」（default · 安全选择），Esc = 继续编辑。*/
withDefaults(defineProps<{ desc: string }>(), { desc: '' })
const emit = defineEmits<{ (e: 'continue'): void; (e: 'discard'): void }>()

const rootEl = ref<HTMLElement | null>(null)
onMounted(() => {
  rootEl.value?.querySelector<HTMLButtonElement>('button.btn-default')?.focus()
})
</script>

<template>
  <div
    ref="rootEl"
    class="unsaved-mask"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="cd-unsaved-title"
    aria-describedby="cd-unsaved-desc"
    @click.self="emit('continue')"
    @keydown.esc="emit('continue')"
  >
    <div class="confirm-dialog">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="confirm-title" id="cd-unsaved-title">放弃未保存的改动？</div>
      <div class="confirm-desc" id="cd-unsaved-desc">{{ desc }}</div>
      <div class="confirm-foot">
        <button class="btn btn-default" type="button" @click="emit('continue')">继续编辑</button>
        <button class="btn btn-danger" type="button" data-testid="discard-unsaved-btn" @click="emit('discard')">放弃改动</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unsaved-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
}
.confirm-dialog {
  width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.confirm-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
}
.confirm-icon svg {
  width: 16px;
  height: 16px;
}
.confirm-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.confirm-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
}
.confirm-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
