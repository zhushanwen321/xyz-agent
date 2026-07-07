<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

/**
 * Table —— 表格根容器（基于原生 <table> 语义包装，统一冷蓝暗色样式）。
 * reka-ui 无 Table 原语，shadcn-vue 的 Table 即原生 table 元素 + 样式封装。
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <table :class="cn('w-full caption-bottom text-[13px]', props.class)">
    <slot />
  </table>
</template>
