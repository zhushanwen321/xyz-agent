<template>
  <!-- Narrow non-interactive rail; only the ↑↓ buttons are clickable -->
  <div class="utility-rail flex flex-col items-center py-2 shrink-0 pointer-events-none">
    <!-- ↑ Scroll to top -->
    <button
      v-if="showScrollTop"
      class="rail-btn pointer-events-auto"
      aria-label="回到顶端"
      @click.stop="$emit('scroll-to-top')"
    >
      <ChevronUp :size="14" />
    </button>

    <div class="flex-1" />

    <!-- ↓ Scroll to bottom -->
    <button
      v-if="showScrollBottom"
      class="rail-btn pointer-events-auto"
      aria-label="回到底部"
      @click.stop="$emit('scroll-to-bottom')"
    >
      <ChevronDown :size="14" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ChevronUp, ChevronDown } from 'lucide-vue-next'

defineProps<{
  showScrollTop: boolean
  showScrollBottom: boolean
}>()

defineEmits<{
  'scroll-to-top': []
  'scroll-to-bottom': []
}>()
</script>

<style scoped>
.utility-rail {
  width: 20px;
}
.rail-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: color 0.15s ease, background 0.15s ease;
}
.rail-btn:hover {
  color: var(--fg);
  background: var(--hover-bg);
}
</style>
