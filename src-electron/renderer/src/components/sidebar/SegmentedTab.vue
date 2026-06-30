<template>
  <!--
    展示组件 · segmented 视图切换 tab（draft-five-states §3）。
    两子视图互斥（sessions | files）；active 态 = accent-soft 背景 + accent 文字 + 半透边。
    仅 icon（label + 计数收进 title 供 hover 查看），宽度自适应内容（不再 flex-1 撑满）。
  -->
  <div class="flex gap-0.5 px-1 pb-1">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :class="cn(
        'h-auto justify-center gap-1.5 rounded-[5px] border border-transparent px-2.5 py-[5px] text-[11.5px]',
        modelValue === tab.value
          ? 'border-border-strong bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
          : 'text-muted hover:bg-surface-hover hover:text-fg',
      )"
      :title="`${tab.label} (${tab.count})`"
      @click="emit('update:modelValue', tab.value)"
    >
      <component :is="tab.icon" class="size-[13px]" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { MessageSquare, File } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SidebarTab } from '@/stores/sidebar'

const props = defineProps<{
  modelValue: SidebarTab
  sessionCount: number
  fileCount: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SidebarTab]
}>()

interface TabDef {
  value: SidebarTab
  label: string
  icon: Component
  count: number
}

/** tabs 响应式读 props 计数；files 计数来自当前 active session 改动文件数（v1 G2-003 defer，传 0） */
const tabs = computed<TabDef[]>(() => [
  { value: 'sessions', label: '会话', icon: MessageSquare, count: props.sessionCount },
  { value: 'files', label: '文件', icon: File, count: props.fileCount },
])
</script>
