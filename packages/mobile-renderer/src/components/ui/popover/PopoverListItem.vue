<script setup lang="ts">
/**
 * 选择类 popover 列表项（架构审查 F5）。
 *
 * 统一 DirSelectPopover（workspace 项）与 BranchSelectPopover（branch 项）逐字相同的
 * Button markup：基础类 + hover 高亮 + 选中高亮（surface-2 + accent ring）+ 选中态 Check。
 * 共享类抽自 composables/logic/popover-styles.ts。
 *
 * 两种高亮（均由调用方计算后传入）：
 * - active：键盘/鼠标导航焦点项 → surface-hover 底（isActiveItem）
 * - selected：当前已选值（当前 cwd / 当前分支）→ surface-2 + accent inset ring（Card-Active）
 *
 * slot default = label 区（cwd 双行 / branch + dirty subline），自外层定义；
 * 命中 selected 时尾部渲染 Check（accent 色）。
 */
import { Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  POPOVER_LIST_ITEM_CLASS,
  POPOVER_LIST_ITEM_ACTIVE_CLASS,
} from '@/composables/logic/popover-styles'

const props = withDefaults(
  defineProps<{
    /** 是否为键盘/鼠标导航焦点项（hover 底色高亮） */
    active?: boolean
    /** 是否为当前已选值（Card-Active：surface-2 + accent ring + 尾部 Check） */
    selected?: boolean
    /** 测试锚点（data-testid） */
    testId?: string
  }>(),
  {
    active: false,
    selected: false,
  },
)

const emit = defineEmits<{
  (e: 'click'): void
  (e: 'mouseenter'): void
}>()
</script>

<template>
  <Button
    :data-testid="props.testId"
    :data-active="props.selected"
    variant="ghost"
    :class="[
      POPOVER_LIST_ITEM_CLASS,
      props.selected ? POPOVER_LIST_ITEM_ACTIVE_CLASS : '',
      props.active ? 'bg-surface-hover' : '',
    ]"
    @click="emit('click')"
    @mouseenter="emit('mouseenter')"
  >
    <!-- leading icon（Folder / GitBranch 等） -->
    <slot name="icon" />
    <!-- label 区（cwd 双行 / branch + dirty subline，自外层定义） -->
    <slot />
    <Check
      v-if="props.selected"
      class="size-4 shrink-0 text-accent"
    />
  </Button>
</template>
