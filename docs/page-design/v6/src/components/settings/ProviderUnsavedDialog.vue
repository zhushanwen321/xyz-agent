<script setup lang="ts">
import { onMounted, ref } from 'vue'

/** M2 未保存保护 + 删除确认 ConfirmDialog（spec §3 AlertDialog 样式）。
 * 焦点初始在安全选择（warn=「继续编辑」default / danger=「取消」ghost），Esc = 安全选择。*/
const props = withDefaults(
  defineProps<{ desc: string; title?: string; kind?: 'warn' | 'danger' }>(),
  { desc: '', title: '放弃未保存的改动？', kind: 'warn' },
)
const emit = defineEmits<{ (e: 'continue'): void; (e: 'discard'): void }>()

const rootEl = ref<HTMLElement | null>(null)
onMounted(() => {
  rootEl.value?.querySelector<HTMLButtonElement>(props.kind === 'danger' ? 'button.btn-ghost' : 'button.btn-default')?.focus()
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
      <div class="confirm-icon" :class="{ danger: props.kind === 'danger' }" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="confirm-title" id="cd-unsaved-title">{{ props.title }}</div>
      <div class="confirm-desc" id="cd-unsaved-desc">{{ props.desc }}</div>
      <div class="confirm-foot">
        <button class="btn" :class="props.kind === 'danger' ? 'btn-ghost' : 'btn-default'" type="button" @click="emit('continue')">{{ props.kind === 'danger' ? '取消' : '继续编辑' }}</button>
        <button class="btn btn-danger" type="button" data-testid="discard-unsaved-btn" @click="emit('discard')">{{ props.kind === 'danger' ? '删除' : '放弃改动' }}</button>
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
  width: 100%;
  max-width: 420px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.confirm-icon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
.confirm-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.confirm-icon svg {
  width: 20px;
  height: 20px;
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
