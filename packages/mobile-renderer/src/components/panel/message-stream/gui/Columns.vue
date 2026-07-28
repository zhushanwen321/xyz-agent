<script setup lang="ts">
/**
 * 双列网格组件——替代 TUI 的 │ 列分隔。
 * flex 布局，ratios 默认等分，通过 style flex-grow 指定比例。
 * children 通过 v-for + GuiComponentRenderer 递归渲染。
 */
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'

const props = defineProps<{
  children: GuiComponent[]
  ratios?: number[]
}>()

const flexGrow = (index: number): number => {
  if (!props.ratios || props.ratios.length === 0) return 1
  return props.ratios[index] ?? 1
}
</script>

<template>
  <div class="flex gap-3" data-testid="gui-columns">
    <div
      v-for="(child, i) in children"
      :key="i"
      class="columns__child min-w-0 flex-1"
      :style="{ flexGrow: flexGrow(i) }"
    >
      <GuiComponentRenderer :component="child" />
    </div>
  </div>
</template>
