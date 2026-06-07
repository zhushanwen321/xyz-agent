<script setup lang="ts">
import { computed, watch, reactive } from 'vue'
import type { ExtensionWidgetPayload } from '@xyz-agent/shared'

const props = defineProps<{
  widgets: ExtensionWidgetPayload[]
}>()

const MAX_WIDGET_COLUMNS = 2

/**
 * Per-widget collapse state: widgetKey → isCollapsed.
 * New widgets start expanded by default.
 */
const collapsedMap = reactive(new Map<string, boolean>())

/** Keep collapsedMap in sync — remove entries for widgets that no longer exist */
watch(() => props.widgets, (newWidgets) => {
  const activeKeys = new Set(newWidgets.map(w => w.widgetKey))
  for (const key of collapsedMap.keys()) {
    if (!activeKeys.has(key)) collapsedMap.delete(key)
  }
})

const columns = computed(() => props.widgets.slice(0, MAX_WIDGET_COLUMNS))

const expandedWidgets = computed(() =>
  columns.value.filter(w => !collapsedMap.get(w.widgetKey))
)

const collapsedWidgets = computed(() =>
  columns.value.filter(w => collapsedMap.get(w.widgetKey))
)

const hasWidgets = computed(() => columns.value.length > 0)

function toggleCollapse(key: string) {
  collapsedMap.set(key, !(collapsedMap.get(key) ?? false))
}
</script>

<template>
  <!-- Only render when there's at least one widget -->
  <div v-if="hasWidgets" class="shrink-0 mx-auto max-w-[960px] w-full px-6 relative">
    <!-- Expanded widget panels -->
    <div
      v-if="expandedWidgets.length > 0"
      class="flex gap-0 overflow-hidden border border-border rounded-sm bg-surface transition-all duration-200"
      style="max-height: 180px"
    >
      <div
        v-for="w in expandedWidgets"
        :key="w.widgetKey"
        class="flex-1 min-w-0 border-r border-border last:border-r-0 flex flex-col overflow-hidden"
      >
        <!-- Column header (opaque sticky — bg-surface so scrolled content doesn't show through) -->
        <div class="flex items-center gap-1.5 px-2.5 py-1 bg-surface border-b border-border shrink-0">
          <span class="font-mono text-[10px] font-semibold text-accent">{{ w.widgetKey }}</span>
          <span class="text-[10px] text-dim truncate flex-1 min-w-0">{{ w.lines[0] ?? '' }}</span>
        </div>
        <!-- Column body (scrollable) -->
        <div class="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div class="py-0.5">
            <div
              v-for="(line, i) in w.lines"
              :key="i"
              class="px-2.5 py-px font-mono text-[11px] leading-relaxed text-muted hover:bg-hover"
            >{{ line }}</div>
          </div>
        </div>
        <!-- Collapse button at bottom -->
        <div class="flex justify-center px-2 py-[3px] border-t border-border shrink-0 bg-surface">
          <!-- eslint-disable-next-line taste/no-native-html-elements -- compact icon button, xyz-ui Button doesn't pass through title -->
          <button
            class="inline-flex items-center gap-1 text-[10px] font-mono text-muted hover:text-fg cursor-pointer bg-transparent border-none transition-colors duration-150"
            title="收起面板"
            @click="toggleCollapse(w.widgetKey)"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
            <span>收起</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Collapsed widget expand buttons — sit between widget panels and ChatInput -->
    <div
      v-if="collapsedWidgets.length > 0"
      class="flex items-center gap-1 px-2 py-[3px] border border-border bg-surface transition-all duration-200"
      :class="{
        'rounded-sm': expandedWidgets.length === 0,
        '-mt-px border-t-0': expandedWidgets.length > 0,
      }"
    >
      <!-- eslint-disable-next-line taste/no-native-html-elements -- compact icon button, xyz-ui Button doesn't pass through title -->
      <button
        v-for="w in collapsedWidgets"
        :key="w.widgetKey"
        class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted hover:text-accent hover:bg-accent-light cursor-pointer bg-transparent border border-border rounded-sm transition-colors duration-150"
        :title="'展开 ' + w.widgetKey + ' 面板'"
        @click="toggleCollapse(w.widgetKey)"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>{{ w.widgetKey }}</span>
      </button>
    </div>
  </div>
</template>
