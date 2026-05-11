<script setup lang="ts">
import { computed } from 'vue'
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaCorner,
} from 'radix-vue'
import { cn } from '../utils'

interface Props {
  class?: string
}

const props = withDefaults(defineProps<Props>(), {
  class: '',
})

const rootClasses = computed(() => cn('overflow-hidden', props.class))
</script>

<template>
  <ScrollAreaRoot :class="rootClasses">
    <ScrollAreaViewport
      class="w-full h-full rounded-[inherit]"
      style="scrollbar-width: none"
    >
      <slot />
    </ScrollAreaViewport>

    <ScrollAreaScrollbar
      class="flex select-none touch-none p-0.5 transition-colors duration-150"
      orientation="vertical"
      :style="{ background: 'transparent' }"
    >
      <ScrollAreaThumb
        class="relative flex-1 rounded-full"
        :style="{ background: 'var(--muted)', opacity: 0.3 }"
      />
    </ScrollAreaScrollbar>

    <ScrollAreaScrollbar
      class="flex select-none touch-none flex-col p-0.5 transition-colors duration-150"
      orientation="horizontal"
      :style="{ background: 'transparent' }"
    >
      <ScrollAreaThumb
        class="relative flex-1 rounded-full"
        :style="{ background: 'var(--muted)', opacity: 0.3 }"
      />
    </ScrollAreaScrollbar>

    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
