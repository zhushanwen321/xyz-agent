<template>
  <!--
    展示组件 · progress-zone（panel/spec.md zone ③，composer 上方）。
    FG4 骨架：可折叠容器空壳。展开态的 todo/goal 列表 + 进度条属 FG5（draft-companion-zones），
    v1 只立容器结构 + 标题行 + 收起态单行占位。无 session 时隐藏。
  -->
  <div
    v-if="sessionLabel"
    class="mx-3.5 mt-2.5 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-black/20"
  >
    <div class="flex items-center gap-2 py-2 pl-3 pr-2.5 text-[12px]">
      <span class="size-[7px] rounded-full bg-subtle" />
      <span class="font-semibold text-fg">{{ sessionLabel }}</span>
      <span class="font-mono text-[11px] text-subtle">进度区待实现</span>
      <Button
        variant="ghost"
        size="icon"
        class="ml-auto size-[22px] rounded-sm text-subtle hover:bg-surface-hover hover:text-muted"
        title="收起/展开"
        @click="collapsed = !collapsed"
      >
        <ChevronDown class="size-3.5 transition-transform" :class="collapsed ? 'rotate-180' : ''" />
      </Button>
    </div>
    <div v-if="!collapsed" class="px-3 pb-2.5">
      <div class="h-1 w-full overflow-hidden rounded bg-white/[0.06]">
        <div class="h-full w-0 rounded bg-accent" />
      </div>
      <p class="mt-2 text-[11px] text-subtle opacity-70">todo / goal 列表待 FG5 实现</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{
  sessionLabel: string
}>()

/** 折叠态（默认收起，骨架阶段不抢焦点） */
const collapsed = ref(true)
</script>
