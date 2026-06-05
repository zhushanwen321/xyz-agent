<template>
  <div class="utility-rail w-9 flex flex-col items-center py-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
    <!-- 3 indicator dots (placeholder, opacity 0 → rail hover 0.6) -->
    <div class="flex flex-col items-center gap-1 mb-2">
      <span class="utility-rail__dot" />
      <span class="utility-rail__dot" />
      <span class="utility-rail__dot" />
    </div>

    <!-- Separator -->
    <div class="utility-rail__sep" />

    <!-- ↑ Scroll to top -->
    <button
      v-if="showScrollTop"
      class="w-6 h-6 flex items-center justify-center rounded-sm text-muted hover:text-fg hover:bg-hover-bg transition-colors"
      aria-label="回到顶端"
      @click="$emit('scroll-to-top')"
    >
      <ChevronUp :size="14" />
    </button>

    <div class="flex-1" />

    <!-- ↓ Scroll to bottom -->
    <button
      v-if="showScrollBottom"
      class="w-6 h-6 flex items-center justify-center rounded-sm text-muted hover:text-fg hover:bg-hover-bg transition-colors"
      aria-label="回到底部"
      @click="$emit('scroll-to-bottom')"
    >
      <ChevronDown :size="14" />
    </button>

    <!-- Bottom separator -->
    <div class="utility-rail__sep mt-2" />
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
.utility-rail__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.group:hover .utility-rail__dot {
  opacity: 0.6;
}

.utility-rail__sep {
  width: 16px;
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
