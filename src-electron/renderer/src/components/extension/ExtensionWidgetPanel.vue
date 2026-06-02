<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'

defineProps<{
  widgetKey: string
  lines: string[]
}>()

const collapsed = ref(false)
</script>

<template>
  <div class="border border-border rounded-sm bg-surface text-sm">
    <div
      role="button"
      tabindex="0"
      class="flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-xs font-medium text-muted hover:text-fg transition-colors cursor-pointer select-none"
      @click="collapsed = !collapsed"
      @keydown.enter="collapsed = !collapsed"
      @keydown.space.prevent="collapsed = !collapsed"
    >
      <component :is="collapsed ? ChevronRight : ChevronDown" class="w-3 h-3 shrink-0" />
      <span class="truncate">{{ widgetKey }}</span>
    </div>
    <div v-if="!collapsed" class="px-3 pb-2">
      <ul class="m-0 p-0 list-none">
        <li
          v-for="(line, i) in lines"
          :key="i"
          class="font-mono text-[11px] leading-relaxed text-muted py-px"
        >{{ line }}</li>
      </ul>
    </div>
  </div>
</template>
