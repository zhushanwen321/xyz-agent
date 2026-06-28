<template>
  <!--
    AppNavControls · 三平台统一应用导航按钮（shell spec §二）。
    收起侧栏 / ← 后退 / → 前进，浮在 traffic-light 右侧。
    全屏态 isFullscreen=true 时 left→20px（响应式 :class 绑定，替代旧 [data-fullscreen] 祖先选择器，
    320ms 平移与 traffic-light opacity 同步）。

    渲染条件（draft-collapsed-state.html 卡 A/B/C）：
    - 非折叠态（① 展开+非全屏 / ② 展开+全屏）：浮此浮层。展开=chrome 跟随 traffic-light 在 AppShell 层，
      全屏态 left:20px 占红黄绿位（红黄绿 OS 隐藏）。
    - 折叠态（③ 折叠+非全屏 / ④ 折叠+全屏）：隐藏此浮层 → chrome 已迁入 P1 PanelHeader（卡 A/B/C）。
      折叠一律由 header 承接，避免与浮层重复渲染两套 chrome。
  -->
  <div
    v-if="!sidebar.collapsed"
    class="app-nav-controls absolute top-[21px] left-[80px] z-10 flex gap-0.5 transition-[left] duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'left-[16px]': isFullscreen }"
  >
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
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
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle [-webkit-app-region:no-drag]"
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
      class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle [-webkit-app-region:no-drag]"
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
