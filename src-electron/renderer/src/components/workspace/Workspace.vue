<template>
  <!--
    容器组件 · Workspace（workspace/spec.md 双 Panel 主从容器）。
    承载 PanelContainer（单/双 panel 主从状态机）。
    FG4 骨架：仅 chat view 内容（Overview 覆盖 main 区属 FG6 ADR-0022，此处不渲染）。
    无 session 时空态引导（spec §8.5 基础空态：欢迎语）。
  -->
  <div class="flex h-full w-full flex-col overflow-hidden">
    <PanelContainer v-if="hasSession" />
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <Sparkles class="size-8 text-accent opacity-70" />
      <div>
        <p class="text-[15px] font-medium text-fg">开始你的第一个任务</p>
        <p class="mt-1 text-[12px] text-muted">
          或按
          <kbd class="ml-1 rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">⌘ N</kbd>
          新建
        </p>
      </div>
      <Button variant="default" size="sm" class="gap-1.5" @click="onNewSession">
        <Plus class="size-[14px]" />
        新建任务
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Plus, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import PanelContainer from './PanelContainer.vue'

const session = useSessionStore()
const { newSession } = useSidebar()

/** 是否有激活 session（决定渲染 panel 还是空态） */
const hasSession = computed(() => session.activeId !== null)

async function onNewSession(): Promise<void> {
  await newSession()
}
</script>
