<template>
  <!--
    展示组件 · segmented 视图切换 tab。
    icon-only 模式：4 tab 等宽均分（flex-1），只显示 icon + count 数字，label 收进 title。
    active 态 = accent-soft 背景 + accent 文字。
  -->
  <div class="flex gap-0.5 px-1 pb-1">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :title="tab.label"
      :class="cn(
        'relative h-auto flex-1 justify-center gap-1 rounded-[5px] px-1 py-[5px]',
        modelValue === tab.value
          ? 'border border-border-strong bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
          : 'border border-border text-muted hover:bg-surface-hover hover:text-fg',
      )"
      @click="emit('update:modelValue', tab.value)"
    >
      <component :is="tab.icon" class="size-[15px] shrink-0" />
      <span
        v-if="tab.count > 0"
        class="font-mono text-[9.5px]"
        :class="modelValue === tab.value ? 'text-accent opacity-80' : 'text-subtle opacity-70'"
      >{{ tab.count }}</span>
      <span
        v-if="tab.badge"
        class="absolute right-1 top-1 size-[6px] rounded-full bg-accent"
      />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { MessageSquare, File, Bot, Workflow } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SidebarTab } from '@/stores/sidebar'

const props = defineProps<{
  modelValue: SidebarTab
  sessionCount: number
  fileCount: number
  subagentCount: number
  workflowCount: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SidebarTab]
}>()

interface TabDef {
  value: SidebarTab
  label: string
  icon: Component
  count: number
  /** 活跃任务时显示蓝点（如 running 态 subagent） */
  badge: boolean
}

/**
 * tabs 响应式读 props 计数。
 * subagentCount > 0 且有 running 态时 badge 亮（当前简化为 count > 0 即亮，后续可按 status 精确判断）。
 */
const tabs = computed<TabDef[]>(() => [
  { value: 'sessions', label: '会话', icon: MessageSquare, count: props.sessionCount, badge: false },
  { value: 'files', label: '文件', icon: File, count: props.fileCount, badge: false },
  { value: 'subagents', label: 'Agents', icon: Bot, count: props.subagentCount, badge: props.subagentCount > 0 },
  { value: 'workflows', label: 'Flows', icon: Workflow, count: props.workflowCount, badge: props.workflowCount > 0 },
])
</script>
