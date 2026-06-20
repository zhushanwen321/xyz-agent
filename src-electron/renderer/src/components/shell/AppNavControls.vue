<template>
  <!--
    AppNavControls · 三平台统一应用导航按钮（shell spec §二）。
    收起侧栏 / ← 后退 / → 前进，浮在 traffic-light 右侧。
    全屏态 isFullscreen=true 时 left→20px（响应式 :class 绑定，替代旧 [data-fullscreen] 祖先选择器，
    320ms 平移与 traffic-light opacity 同步）。
  -->
  <div
    class="app-nav-controls absolute top-[16px] left-[90px] z-10 flex gap-0.5 transition-[left] duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'left-[20px]': isFullscreen }"
  >
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
      :title="sidebar.collapsed ? '展开侧栏' : '收起侧栏'"
      aria-label="切换侧栏"
      @click="sidebar.toggleCollapsed()"
    >
      <PanelLeftOpen v-if="sidebar.collapsed" class="size-[14px]" />
      <PanelLeftClose v-else class="size-[14px]" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
      :disabled="!navigation.canBack"
      title="后退"
      aria-label="后退"
      @click="navigation.back()"
    >
      <ArrowLeft class="size-[14px]" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
      :disabled="!navigation.canForward"
      title="前进"
      aria-label="前进"
      @click="navigation.forward()"
    >
      <ArrowRight class="size-[14px]" />
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * 容器组件：注入 navigation + sidebar store。
 * ←/→ 绑定导航历史栈 back/forward（与 Flow 4 分支回退解耦）。
 * 收起按钮 toggle sidebar.collapsed；折叠态宽度视觉属 L2（W09），此处只切状态。
 * 按钮尺寸 26×22 = draft-overlay-states.html nav-btn 精确值（非 token 化，设计稿像素级要求）。
 */
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarStore } from '@/stores/sidebar'

const navigation = useNavigationStore()
const sidebar = useSidebarStore()
const { isFullscreen } = usePlatformChrome()
</script>
