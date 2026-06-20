<template>
  <!--
    展示组件 · segmented 视图切换 tab（draft-five-states §3）。
    两子视图互斥（sessions | files）；active 态 = accent-soft 背景 + accent 文字 + 半透边。
    每个 tab 右侧小字计数（会话 N / 文件 M），不切换即知规模。
    files tab 的计数 = 当前 active session 改动文件数（G2-003 defer 内容，v1 计数置 0）。
  -->
  <div class="flex gap-0.5 px-1 pb-1">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :class="cn(
        'h-auto flex-1 justify-center gap-1.5 rounded-[5px] border border-transparent px-2 py-[5px] text-[11.5px]',
        modelValue === tab.value
          ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
          : 'text-muted hover:bg-surface-hover hover:text-fg',
      )"
      @click="emit('update:modelValue', tab.value)"
    >
      <component :is="tab.icon" class="size-[13px]" />
      <span>{{ tab.label }}</span>
      <span
        class="font-mono text-[10px]"
        :class="modelValue === tab.value ? 'text-accent opacity-80' : 'text-subtle opacity-70'"
      >{{ tab.count }}</span>
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
