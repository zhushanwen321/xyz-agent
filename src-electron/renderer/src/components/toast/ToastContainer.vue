<template>
  <div class="fixed top-[60px] left-5 z-[60] flex flex-col gap-2 pointer-events-none">
    <TransitionGroup name="toast-list">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="w-[340px] bg-surface border border-border rounded py-3 px-[14px] shadow-lg pointer-events-auto flex gap-[10px]"
        :class="{ 'opacity-0 -translate-x-[120%]': toast.removing }"
      >
        <span class="w-2 h-2 rounded-full shrink-0 mt-1" :style="{ background: dotColor(toast.type) }"></span>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-semibold mb-[2px]">{{ toast.title }}</div>
          <div v-if="toast.description" class="text-xs text-muted leading-snug">{{ toast.description }}</div>
          <div v-if="toast.actions?.length" class="flex gap-[6px] mt-2">
            <Button
              v-for="action in toast.actions"
              :key="action.label"
              size="sm"
              :class="['py-1 px-[10px] rounded-xs text-[11px] font-body cursor-pointer transition-all duration-150 ease-ease border border-border bg-transparent text-muted hover:border-accent hover:text-accent', { 'bg-accent text-white border-accent hover:opacity-[0.88]': action.primary }]"
              @click="action.handler"
            >
              {{ action.label }}
            </Button>
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

import { Button } from '../../design-system'

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
/* Vue TransitionGroup animation classes — cannot be expressed as Tailwind template utilities */
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
