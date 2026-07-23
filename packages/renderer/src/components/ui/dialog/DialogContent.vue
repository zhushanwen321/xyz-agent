<script setup lang="ts">
import { computed, useAttrs } from "vue"
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

// 禁用自动继承：模板根元素是 DialogPortal（reka-ui），它内部用 <Teleport> 渲染，
// Vue 无法在 Teleport 上继承 non-prop attrs（如 data-testid），会触发 warn。
// inheritAttrs:false 后，$attrs 不再 fallthrough 到 Portal，由内层 reka-ui
// DialogContent 的 v-bind="mergedAttrs" 显式接收（那才是渲染 DOM 面板的元素）。
defineOptions({ inheritAttrs: false })

const props = defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; hideClose?: boolean }>()
const emits = defineEmits<DialogContentEmits>()
const attrs = useAttrs()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
/** 合并 forwarded props + fallthrough attrs（如 data-testid），一次性绑到内层 reka-ui DialogContent */
const mergedAttrs = computed(() => ({ ...forwarded, ...attrs }))
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      class="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <DialogContent
      v-bind="mergedAttrs"
      :class="
        cn(
          'fixed left-1/2 top-1/2 z-[1000] grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-surface p-6 shadow-lg duration-200 select-text data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
          props.class,
        )"
      >
      <slot />

      <!-- 关闭按钮：默认 absolute 右上角。消费者提供 hideClose 时隐藏（自行在内容内渲染 DialogClose） -->
      <DialogClose
        v-if="!props.hideClose"
        class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-surface-hover data-[state=open]:text-muted-foreground"
      >
        <X class="w-4 h-4" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
