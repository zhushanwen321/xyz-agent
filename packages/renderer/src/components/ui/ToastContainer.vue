<template>
  <TransitionGroup
    tag="div"
    name="toast"
    class="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none"
  >
    <div
      v-for="t in toasts"
      :key="t.id"
      class="pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg"
      :class="toastClass(t.type)"
    >
      <!-- error icon: lucide alert-circle -->
      <svg
        v-if="t.type === 'error'"
        class="mt-px h-4 w-4 shrink-0 text-danger"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
      <!-- warning icon: lucide alert-triangle -->
      <svg
        v-else-if="t.type === 'warning'"
        class="mt-px h-4 w-4 shrink-0 text-warning"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
      <!-- info icon: lucide info -->
      <svg
        v-else
        class="mt-px h-4 w-4 shrink-0 text-info"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
      <span>{{ t.message }}</span>
      <Button
        variant="ghost"
        class="ml-2 size-6 rounded-sm p-0 opacity-60 hover:opacity-100"
        @click="remove(t.id)"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </Button>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { useToast } from '@/composables/useToast'

const { toasts, remove } = useToast()

/** toast 类型 → 颜色 class */
function toastClass(type: 'error' | 'info' | 'warning'): string {
  if (type === 'error') return 'border-border bg-surface text-danger'
  if (type === 'warning') return 'border-border bg-surface text-warning'
  return 'border-border bg-surface text-fg'
}
</script>

<style scoped>
.toast-enter-active { transition: all 0.3s ease-out; }
.toast-leave-active { transition: all 0.2s ease-in; }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
