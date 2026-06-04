<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ExtensionWidgetPayload } from '@xyz-agent/shared'

const props = defineProps<{
  widgets: ExtensionWidgetPayload[]
}>()

const MAX_WIDGET_COLUMNS = 2
const collapsed = ref(false)

/** 最多展示 2 列 */
const columns = computed(() => props.widgets.slice(0, MAX_WIDGET_COLUMNS))
const hasWidgets = computed(() => columns.value.length > 0)
</script>

<template>
  <!-- 仅当有 widget 数据时才渲染整个区域 -->
  <div v-if="hasWidgets" class="shrink-0 mx-auto max-w-[960px] w-full px-6 relative">
    <!-- 展开的 WidgetDock -->
    <div
      v-show="!collapsed"
      class="flex gap-0 overflow-hidden border border-border rounded-sm bg-surface transition-all duration-200"
      style="max-height: 180px"
    >
      <div
        v-for="w in columns"
        :key="w.widgetKey"
        class="flex-1 min-w-0 border-r border-border last:border-r-0 overflow-y-auto overflow-x-hidden"
      >
        <!-- Column header -->
        <div class="flex items-center gap-1.5 px-2.5 py-1 bg-inset border-b border-border sticky top-0 z-1">
          <span class="font-mono text-[10px] font-semibold text-accent">{{ w.widgetKey }}</span>
          <span class="text-[10px] text-dim truncate flex-1 min-w-0">{{ w.lines[0] ?? '' }}</span>
          <!-- 收起按钮 -->
          <button
            class="w-[18px] h-[18px] flex items-center justify-center border border-border rounded-sm bg-transparent text-muted hover:bg-hover hover:text-fg transition-colors duration-150 cursor-pointer"
            title="收起面板"
            @click="collapsed = true"
          >
            <!-- sidebar-collapse: 箭头指向右边栏 -->
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="1" />
              <line x1="15" y1="3" x2="15" y2="21" />
              <polyline points="10 9 7 12 10 15" />
            </svg>
          </button>
        </div>
        <!-- Column body -->
        <div class="py-0.5">
          <div
            v-for="(line, i) in w.lines"
            :key="i"
            class="px-2.5 py-px font-mono text-[11px] leading-relaxed text-muted hover:bg-hover"
          >{{ line }}</div>
        </div>
      </div>
    </div>

    <!-- 折叠后的悬浮按钮：位于 ChatInput 右侧边距 -->
    <button
      v-if="collapsed"
      class="absolute -right-[26px] bottom-[14px] w-5 h-5 flex items-center justify-center border border-border rounded-[3px] bg-surface text-accent hover:bg-hover transition-colors duration-150 cursor-pointer z-10"
      title="展开面板"
      @click="collapsed = false"
    >
      <!-- sidebar-expand: 箭头从右边栏展开 -->
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="10 9 7 12 10 15" />
      </svg>
    </button>
  </div>
</template>
