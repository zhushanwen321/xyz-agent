<template>
  <!--
    展示组件 · segmented 视图切换 tab（v6-master-spec §5.3）。
    icon-only 模式：4 tab 等宽均分（flex-1），只显示 icon，label 收进 title（count 数字已移除，克制原则）。
    外层凹陷容器 bg-bg-input + rounded-lg + p-[3px]；active = bg-bg-elevated 中性浮起（去蓝染）。
    inactive hover 只提亮文字（text-neutral-fg），不加底色——凹陷槽内加底色会显脏（demo SegmentedTab 同源）。
  -->
  <div class="mx-1 mb-1 flex gap-0.5 rounded-lg bg-bg-input p-[3px]">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :title="tab.label"
      :class="cn(
        'relative h-7 flex-1 justify-center gap-1 rounded-sm px-1',
        modelValue === tab.value
          ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated hover:text-neutral-fg'
          : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg',
      )"
      @click="emit('update:modelValue', tab.value)"
    >
      <component :is="tab.icon" class="size-[15px] shrink-0" />
      <span
        v-if="tab.badge"
        class="absolute right-1 top-1 size-[7px] rounded-full bg-accent animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
      />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { MessageSquare, File, Bot, Workflow } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SidebarTab } from '@/stores/sidebar'

const { t } = useI18n()

const props = defineProps<{
  modelValue: SidebarTab
  sessionCount: number
  fileCount: number
  subagentCount: number
  workflowCount: number
  /** running 态数量（badge 精确化：仅 running>0 亮蓝点，避免已完成任务也亮） */
  subagentRunningCount: number
  workflowRunningCount: number
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
 * badge 精确化：仅 running 态 > 0 亮蓝点（需关注的任务），已完成任务不亮。
 */
const tabs = computed<TabDef[]>(() => [
  { value: 'sessions', label: t('sidebar.segmentedTab.session'), icon: MessageSquare, count: props.sessionCount, badge: false },
  { value: 'files', label: t('sidebar.segmentedTab.file'), icon: File, count: props.fileCount, badge: false },
  { value: 'subagents', label: t('sidebar.segmentedTab.subagent'), icon: Bot, count: props.subagentCount, badge: props.subagentRunningCount > 0 },
  { value: 'workflows', label: t('sidebar.segmentedTab.workflow'), icon: Workflow, count: props.workflowCount, badge: props.workflowRunningCount > 0 },
])
</script>
