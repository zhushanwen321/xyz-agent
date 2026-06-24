<!--
  SideDrawer —— 右抽屉容器（issues.md #9 / code-architecture §4.10 / panel/spec.md）。
  Terminal/Browser 两 tab（§6.3 点2，不含 Diff——Diff 审批 Out-of-scope，见 spec FR-8）。
  与 Panel 数据强耦合，固定挂触发 Panel（panel/spec.md），由 Panel.vue 渲染为 section 内 absolute 浮层。

  状态控制走 useSideDrawer（§6.3 点5 架构解耦）：本组件只接收 isOpen/activeTab/docked props
  + emit close/set-tab/toggle-dock，不持有状态。widget 订阅（#11 W3a）将按 props.sessionId
  在本组件内接入 extension.onWidget——本轮仅建容器 + tab 切换 + 空态占位。
-->
<template>
  <Transition name="drawer-slide">
    <aside
      v-if="isOpen"
      class="absolute right-0 top-0 z-30 flex h-full w-[340px] flex-col border-l border-border-strong bg-bg-elevated shadow-2xl"
      aria-label="侧边抽屉"
    >
      <!-- header：tab 栏（左）+ 钉住/关闭（右） -->
      <header class="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div class="flex flex-1 gap-0.5">
          <Button
            v-for="t in tabs"
            :key="t.key"
            variant="ghost"
            class="h-7 gap-1 rounded-sm px-2 text-[12px]"
            :class="activeTab === t.key ? 'bg-accent-soft text-accent' : 'text-muted'"
            :title="t.label"
            @click="emit('set-tab', t.key)"
          >
            <component :is="t.icon" class="size-3" />
            {{ t.label }}
          </Button>
        </div>

        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0"
          :class="docked ? 'text-accent' : 'text-subtle'"
          :title="docked ? '取消钉住' : '钉住'"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-subtle hover:text-fg"
          title="关闭"
          @click="emit('close')"
        >
          <X class="size-3" />
        </Button>
      </header>

      <!-- 内容区：Terminal / Browser（widget 订阅 #11 W3a，本轮空态占位） -->
      <div class="min-h-0 flex-1 overflow-auto">
        <div
          v-if="activeTab === 'terminal'"
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <TerminalIcon class="size-6 text-subtle opacity-40" />
          <p class="text-[12px] text-subtle opacity-70">暂无终端输出</p>
          <p class="text-[11px] text-subtle opacity-50">widget 订阅接入后显示实时输出</p>
        </div>
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <Globe class="size-6 text-subtle opacity-40" />
          <p class="text-[12px] text-subtle opacity-70">暂无浏览器预览</p>
          <p class="text-[11px] text-subtle opacity-50">widget 订阅接入后显示预览</p>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, Pin, PinOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'

defineProps<{
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
}>()

const emit = defineEmits<{
  close: []
  'set-tab': [tab: SideDrawerTab]
  'toggle-dock': []
}>()

interface TabMeta {
  key: SideDrawerTab
  label: string
  icon: Component
}

/** tab 元信息（§6.3 点2：Terminal/Browser，不含 Diff） */
const tabs: TabMeta[] = [
  { key: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { key: 'browser', label: 'Browser', icon: Globe },
]
</script>

<style scoped>
/* 抽屉从右滑入/滑出（panel/spec.md 右抽屉从右滑出）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时变换）。 */
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition:
    transform var(--duration-slow) var(--ease),
    opacity var(--duration-slow) var(--ease);
}
</style>
