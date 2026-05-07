<template>
  <div class="toast-container">
    <TransitionGroup name="toast-list">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :class="{ removing: toast.removing }"
      >
        <span class="toast__dot" :style="{ background: dotColor(toast.type) }"></span>
        <div class="toast__body">
          <div class="toast__title">{{ toast.title }}</div>
          <div v-if="toast.description" class="toast__desc">{{ toast.description }}</div>
          <div v-if="toast.actions?.length" class="toast__actions">
            <button
              v-for="action in toast.actions"
              :key="action.label"
              :class="['toast__btn', { 'toast__btn--primary': action.primary }]"
              @click="action.handler"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
export interface ToastAction {
  label: string
  primary?: boolean
  handler: () => void
}

export interface ToastItem {
  id: string
  type: 'success' | 'warning' | 'danger' | 'info'
  title: string
  description?: string
  actions?: ToastAction[]
  removing?: boolean
}

defineProps<{ toasts: ToastItem[] }>()
defineEmits<{ dismiss: [id: string] }>()

function dotColor(type: string) {
  switch (type) {
    case 'success': return 'var(--success)'
    case 'warning': return 'var(--warning)'
    case 'danger': return 'var(--danger)'
    default: return 'var(--accent)'
  }
}
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 60px;
  left: 20px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  width: 340px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  pointer-events: auto;
  display: flex;
  gap: 10px;
}

.toast.removing {
  opacity: 0;
  transform: translateX(-120%);
}

.toast__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}

.toast__body {
  flex: 1;
  min-width: 0;
}

.toast__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}

.toast__desc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}

.toast__actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.toast__btn {
  padding: 4px 10px;
  border-radius: var(--radius-xs);
  font-size: 11px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
}

.toast__btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.toast__btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.toast__btn--primary:hover {
  opacity: 0.88;
}

/* Transition */
.toast-list-enter-from {
  transform: translateX(-120%);
  opacity: 0;
}

.toast-list-enter-active {
  transition: all 0.35s var(--ease);
}

.toast-list-leave-to {
  transform: translateX(-120%);
  opacity: 0;
}

.toast-list-leave-active {
  transition: all 0.25s var(--ease);
}
</style>
