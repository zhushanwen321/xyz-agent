<template>
  <div class="w-9 flex flex-col items-center py-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
    <button
      v-if="showScrollTop"
      class="w-6 h-6 flex items-center justify-center rounded-sm text-muted hover:text-fg hover:bg-hover-bg transition-colors"
      aria-label="回到顶端"
      @click="$emit('scroll-to-top')"
    >
      <ChevronUp :size="14" />
    </button>
    <div class="flex-1" />
    <button
      v-if="showScrollBottom"
      class="w-6 h-6 flex items-center justify-center rounded-sm text-muted hover:text-fg hover:bg-hover-bg transition-colors"
      aria-label="回到底部"
      @click="$emit('scroll-to-bottom')"
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
