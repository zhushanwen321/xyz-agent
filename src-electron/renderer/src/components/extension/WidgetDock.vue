<script setup lang="ts">
import { computed } from 'vue'
import type { ExtensionWidgetPayload } from '@xyz-agent/shared'

const props = defineProps<{
  widgets: ExtensionWidgetPayload[]
}>()

const MAX_WIDGET_COLUMNS = 2

/** 最多展示 2 列 */
const columns = computed(() => props.widgets.slice(0, MAX_WIDGET_COLUMNS))
</script>

<template>
  <div v-if="columns.length > 0" class="shrink-0 border-t border-border bg-surface">
    <div
      :class="[
        'flex gap-0 overflow-hidden',
        'flex gap-0 overflow-hidden',
      ]"
      style="max-height: 180px"
    >
      <div
        v-for="w in columns"
        :key="w.widgetKey"
        class="flex-1 min-w-0 border-r border-border last:border-r-0 overflow-y-auto overflow-x-hidden"
      >
        <!-- Column header -->
        <div class="flex items-center gap-1.5 px-2 py-1 bg-inset border-b border-border sticky top-0 z-1">
          <span class="font-mono text-[10px] font-semibold text-accent">{{ w.widgetKey }}</span>
          <span class="text-[10px] text-dim truncate flex-1 min-w-0">{{ w.lines[0] ?? '' }}</span>
        </div>
        <!-- Column body: render lines -->
        <div class="py-0.5">
          <div
            v-for="(line, i) in w.lines"
            :key="i"
            class="px-2 py-px font-mono text-[11px] leading-relaxed text-muted hover:bg-hover"
          >{{ line }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
