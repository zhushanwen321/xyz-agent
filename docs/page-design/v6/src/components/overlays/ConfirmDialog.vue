<script setup lang="ts">
import { computed } from 'vue'

/**
 * §4.6 ConfirmDialog · reka Dialog 风格确认框。
 * z-modal(1000) + bg-black/80 backdrop-blur 遮罩，居中 cd-dialog（max 360px，bg-surface，radius-lg，shadow-2）。
 * v6 三处收敛：①圆角 radius-lg(12px)；②danger 三角 icon size-4(16px)（从 size-5 降档）；
 * ③variant 驱动 icon 色 + confirm 按钮 variant（danger→btn-danger，其余→btn-default）。
 */

type Variant = 'danger' | 'warning' | 'info' | 'default'

const props = withDefaults(defineProps<{
  variant?: Variant
  title: string
  desc?: string
  confirmText?: string
  cancelText?: string
}>(), {
  variant: 'default',
  desc: '',
  confirmText: '确认',
  cancelText: '取消',
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

/** variant → confirm 按钮 class（danger 走 btn-danger，其余走 btn-default）*/
const confirmBtnClass = computed(() => {
  return props.variant === 'danger' ? 'btn btn-danger btn-sm' : 'btn btn-default btn-sm'
})

function onBackdropClick() {
  emit('cancel')
}
</script>

<template>
  <div class="cd-overlay" @click.self="onBackdropClick">
    <div class="cd-dialog" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <div class="cd-header">
        <div class="cd-title-row">
          <!-- danger / warning：TriangleAlert（lucide）size-4(16px) -->
          <svg
            v-if="variant === 'danger' || variant === 'warning'"
            class="cd-ico"
            :class="variant === 'danger' ? 'danger' : 'warn'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <!-- info：Info icon size-4(16px) -->
          <svg
            v-else-if="variant === 'info'"
            class="cd-ico info"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span class="cd-title">{{ title }}</span>
        </div>
        <p v-if="desc" class="cd-desc">{{ desc }}</p>
      </div>

      <div class="cd-actions">
        <button class="btn btn-ghost btn-sm" @click="emit('cancel')">{{ cancelText }}</button>
        <button :class="confirmBtnClass" @click="emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
}
.cd-dialog {
  position: relative;
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 24px;
}

.cd-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cd-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cd-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--neutral-fg);
}
.cd-desc {
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-mid);
}

/* variant icon size-4 (16px) v6：从 size-5(20px) 降档 */
.cd-ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.cd-ico.danger {
  color: var(--danger);
}
.cd-ico.warn {
  color: var(--warn);
}
.cd-ico.info {
  color: var(--info);
}

.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
}
</style>
