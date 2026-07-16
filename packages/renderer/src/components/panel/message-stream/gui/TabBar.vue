<script setup lang="ts">
/**
 * 标签栏组件——替代 TUI 的 tab │ 分隔。
 * active 用 accent-soft 背景高亮，status=done 显绿点，status=pending 显灰点半透明。
 */
import type { GuiComponentProps } from '@xyz-agent/extension-protocol'

defineProps<{
  tabs: GuiComponentProps['tab-bar']['tabs']
}>()

const dotClass = (status?: 'done' | 'pending') => {
  if (status === 'done') return 'bg-success'
  if (status === 'pending') return 'bg-subtle opacity-50'
  return ''
}
</script>

<template>
  <div class="tab-bar flex gap-0.5 border-b border-border pb-px" data-testid="gui-tab-bar">
    <div
      v-for="(tab, i) in tabs"
      :key="i"
      class="tab-bar__tab flex items-center gap-1 rounded-t-sm px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:text-muted"
      :class="{ 'bg-accent-soft text-accent': tab.active }"
    >
      <span
        v-if="tab.status"
        class="tab-bar__dot size-[5px] shrink-0 rounded-full"
        :class="dotClass(tab.status)"
      />
      <span :class="{ 'text-success': tab.status === 'done' && !tab.active }">{{ tab.label }}</span>
    </div>
  </div>
</template>
