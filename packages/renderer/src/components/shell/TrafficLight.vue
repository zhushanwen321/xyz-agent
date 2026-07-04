<template>
  <!--
    TrafficLight · 跨平台窗口控制（shell spec §五方案 X）
    - mac：空占位 div（保留 .traffic-light 定位 + opacity transition 语义，红黄绿由 OS 绘制）
    - win/linux：自绘 3 彩色圆点 mimic mac，hover 整组显 close/min/max 符号，点击 IPC 控窗口
    全屏态 isFullscreen=true 时 opacity→0（响应式 :class 绑定，替代旧 [data-fullscreen] 祖先选择器），
    mac 系统 hover 浮层独立不参与。
  -->
  <div
    class="traffic-light absolute left-[16px] top-[26px] flex gap-2 z-10 transition-opacity duration-[var(--duration-slow)] ease-[var(--ease)] group"
    :class="{ 'opacity-0': isFullscreen }"
  >
    <template v-if="!isMac">
      <Button
        v-for="dot in dots"
        :key="dot.action"
        variant="ghost"
        :aria-label="dot.label"
        :title="dot.label"
        class="tl-dot h-3 w-3 grid place-items-center rounded-full border border-black/25 p-0 hover:bg-transparent"
        :class="dot.bgClass"
        @click="onAction(dot.action)"
      >
        <component
          :is="dot.icon"
          :size="8"
          class="text-black/55 opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100"
        />
      </Button>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 纯展示 + 窗口控制副作用。
 * 平台判定：detectPlatform() 纯字符串匹配（模块加载时算一次，平台运行期不变）。
 * 全屏态：usePlatformChrome 单例 isFullscreen ref（onMounted 注册 IPC 监听）。
 * 窗口控制仅 win/linux 触发；mac 下模板不渲染按钮，事件不可达。
 */
import { type FunctionalComponent } from 'vue'
import { X, Minus, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { detectPlatform, usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { windowClose, windowMinimize, windowToggleMaximize } from '@/lib/ipc'

type WinAction = 'minimize' | 'toggleMaximize' | 'close'
interface DotDef {
  bgClass: string
  action: WinAction
  label: string
  icon: FunctionalComponent<{ size?: number }>
}

const isMac = detectPlatform() === 'mac'
const { isFullscreen } = usePlatformChrome()

// 红=close / 黄=minimize / 绿=maximize（mac 红黄绿标准映射）
const dots: DotDef[] = [
  { bgClass: 'bg-[#ff5f57]', action: 'close', label: '关闭', icon: X },
  { bgClass: 'bg-[#febc2e]', action: 'minimize', label: '最小化', icon: Minus },
  { bgClass: 'bg-[#28c840]', action: 'toggleMaximize', label: '最大化', icon: Plus },
]

function onAction(action: WinAction): void {
  if (action === 'minimize') void windowMinimize()
  else if (action === 'toggleMaximize') void windowToggleMaximize()
  else void windowClose()
}
</script>
