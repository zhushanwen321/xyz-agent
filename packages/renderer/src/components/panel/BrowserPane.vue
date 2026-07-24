<template>
  <!--
    BrowserPane —— 嵌入式浏览器面板（Browser Drawer Wave 2）。

    挂在 SideDrawer 的 browser tab，点击 agent 输出的 http(s) 链接 → drawer.open('browser',{url})
    → SideDrawer 显本组件 → onMounted 创建 WebContentsView（主进程）+ 加载 url + show。
    主进程 webContents 事件经 onBrowserState 推回，更新地址栏真实 URL（防钓鱼）+ loading/error 态。

    Wave 2 最小闭环：
    - 导航栏骨架（back/forward 占位 disabled，reload 可用，外链导出降级到系统浏览器）
    - viewport 占位区（Wave 3 接 rect 同步，Wave 2 仅状态占位）
    - 加载 / 错误 / 空态三态切换

    安全：WebContentsView 由主进程创建，零信任 webPreferences（contextIsolation + sandbox），
    本组件不接触 webContents，只经 IPC 触发 create/navigate/hide/show。
  -->
  <div class="flex h-full flex-col" data-testid="browser-pane">
    <!-- 导航栏骨架 -->
    <div class="flex-shrink-0 border-b border-border">
      <div class="flex items-center gap-1 px-2 py-1.5">
        <!-- back/forward 占位：Wave 2 不接 history，先 disabled -->
        <Button variant="ghost" size="icon" disabled data-testid="browser-back" class="size-7" :title="t('panel.browserPane.back')">
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon" disabled data-testid="browser-forward" class="size-7" :title="t('panel.browserPane.forward')">
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon" data-testid="browser-reload" class="size-7" :title="t('panel.browserPane.reload')" @click="reload">
          <RotateCw />
        </Button>
        <!-- 地址栏：显示真实 URL（主进程 did-navigate 回填，防钓鱼）。-->
        <div
          class="mx-1 flex flex-1 items-center gap-1.5 rounded-full bg-bg-input px-3 py-1"
          data-testid="browser-urlbar"
        >
          <Lock v-if="isSecure" class="size-3 text-success" />
          <span class="truncate font-mono text-[11px] text-fg">{{ displayUrl || 'about:blank' }}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          data-testid="browser-open-external"
          class="size-7"
          :title="t('panel.browserPane.openExternal')"
          :disabled="!displayUrl"
          @click="openInExternal"
        >
          <ExternalLink />
        </Button>
      </div>
    </div>

    <!-- viewport 占位区（Wave 3 接 rect 同步：主进程 setBounds 用此元素的位置/尺寸）。
         Wave 2 仅渲染加载 / 错误 / 空态三态，真实页面由主进程 WebContentsView 覆盖渲染。-->
    <div ref="viewportEl" class="relative min-h-0 flex-1 bg-bg" data-testid="browser-vp">
      <!-- 加载态 -->
      <div
        v-if="isLoading"
        class="absolute inset-0 flex flex-col items-center justify-center gap-3"
        data-testid="browser-loading"
      >
        <div class="size-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span class="font-mono text-[11px] text-muted">{{ displayUrl }}</span>
      </div>
      <!-- 错误态 -->
      <div
        v-else-if="error"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4"
        data-testid="browser-error"
      >
        <AlertCircle class="size-8 text-danger" />
        <span class="text-[13px] font-semibold text-fg">{{ t('panel.browserPane.loadFailed') }}</span>
        <span class="max-w-[240px] text-center text-[11px] text-muted">{{ error.errorDescription }}</span>
        <div class="mt-2 flex gap-2">
          <Button variant="secondary" size="sm" @click="reload">{{ t('panel.browserPane.retry') }}</Button>
          <Button variant="ghost" size="sm" @click="openInExternal">{{ t('panel.browserPane.openExternal') }}</Button>
        </div>
      </div>
      <!-- 空态（无 url）-->
      <div
        v-else-if="!url"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2"
        data-testid="browser-empty"
      >
        <Globe class="size-10 text-subtle opacity-40" />
        <span class="text-[12px] text-subtle">{{ t('panel.browserPane.empty') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * BrowserPane 脚本：生命周期 + 状态订阅。
 *
 * 流程：
 * - onMounted：browserCreate(sessionId, windowId) → 若 url：browserNavigate + browserShow → 订阅 onBrowserState
 * - onBeforeUnmount：browserHide（keep-alive，不 destroy）
 * - onBrowserState：更新 displayUrl（真实 URL，防钓鱼）+ isLoading + error
 * - windowId：从 URLSearchParams(window.location.search).get('windowId') 读（主窗口 URL 是 ?windowId=win-1，
 *   由 window-factory 注入）。项目无现成 getCurrentWindowId 工具，用 URLSearchParams 最简。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Lock,
  ExternalLink,
  AlertCircle,
  Globe,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  browserCreate,
  browserNavigate,
  browserHide,
  browserShow,
  onBrowserState,
  openExternal,
} from '@/lib/ipc'

/** 主进程推送的 browser 加载错误结构（与 BrowserViewState.error 对齐） */
interface BrowserLoadError {
  errorCode: number
  errorDescription: string
  validatedURL: string
}

const props = defineProps<{
  /** widget 订阅的 session 标识（与 SideDrawer sessionId 一致，作 WebContentsView key） */
  sessionId: string
  /** 打开时立即加载的 URL（点击 agent 输出的链接传入）；为空显空态 */
  url: string
}>()

const { t } = useI18n()

/** viewport 容器 ref（Wave 3 接 rect 同步用，Wave 2 仅占位） */
const viewportEl = ref<HTMLElement | null>(null)

/** 地址栏显示 URL：初始 = props.url，由 onBrowserState 更新为真实 URL（防钓鱼） */
const displayUrl = ref<string>(props.url)
/** 加载态（初始有 url 时 true，等主进程 did-stop-loading 推 false） */
const isLoading = ref<boolean>(Boolean(props.url))
/** 最近一次加载错误（成功导航后清空） */
const error = ref<BrowserLoadError | null>(null)

/** 是否 https（地址栏锁标） */
const isSecure = computed(() => displayUrl.value.startsWith('https://'))

/**
 * 读取当前窗口的 windowId。
 * window-factory 创建窗口时把 windowId 注入 URL query（dev: ?windowId=win-1；prod: loadFile query）。
 * 项目无现成 getCurrentWindowId 工具，从 window.location.search 读最简。
 */
function getCurrentWindowId(): string {
  try {
    return new URLSearchParams(window.location.search).get('windowId') ?? ''
  } catch {
    return ''
  }
}

/** onBrowserState 取消订阅函数（onBeforeUnmount 调） */
let unsubscribe: (() => void) | null = null

onMounted(() => {
  const windowId = getCurrentWindowId()
  // 创建 WebContentsView（attach 到主窗口，初始隐藏）。幂等：已存在则主进程复用。
  void browserCreate(props.sessionId, windowId)

  // 有初始 url：导航 + 显示
  if (props.url) {
    void browserNavigate(props.sessionId, props.url)
    void browserShow(props.sessionId)
  }

  // 订阅状态推送（地址栏真实 URL 回填 + loading/error 态）。仅处理本 sessionId 的推送。
  unsubscribe = onBrowserState((state) => {
    if (state.sessionId !== props.sessionId) return
    if (state.currentUrl) displayUrl.value = state.currentUrl
    isLoading.value = state.isLoading
    error.value = state.error
  })
})

onBeforeUnmount(() => {
  // hide（keep-alive，不 destroy）：切 tab/关 drawer 时隐藏 WebContentsView，下次打开复用。
  void browserHide(props.sessionId)
  unsubscribe?.()
  unsubscribe = null
})

/** 重载当前 URL */
function reload(): void {
  const target = displayUrl.value || props.url
  if (!target) return
  isLoading.value = true
  error.value = null
  void browserNavigate(props.sessionId, target)
}

/** 在系统浏览器打开当前 URL（降级出口） */
function openInExternal(): void {
  const target = displayUrl.value || props.url
  if (!target) return
  void openExternal(target)
}
</script>
