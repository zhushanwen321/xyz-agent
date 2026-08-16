<!--
  TerminalView —— drawer 集成终端的交互式渲染组件（Phase 3）。

  基于 xterm.js + addons（fit/web-links/search/unicode11），接收 sessionId prop。
  生命周期解耦（见 useTerminal 注释）：本组件只管 xterm 实例，PTY + scrollback 在 useTerminal。

  mount 流程：新建 xterm → 回放 scrollback → 若 !ptyAlive 发 spawn（cwd 取 session.cwd）→ attach
  unmount 流程：xterm.dispose()（PTY + buffer 不动，切回重放）
-->
<template>
  <div data-testid="terminal-view" class="flex h-full flex-col">
    <!-- 工具栏：clear / kill。2026-08-14 裁决遵循 v6-drawer-tabs-demo：跟随 drawer 深底、
         去 border-white/10（层级靠底色差不靠边框），按钮 neutral 配色（spec .tv-v6 的按钮规范）。 -->
    <div data-testid="terminal-toolbar" class="flex items-center gap-1 px-2 py-1">
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        :title="t('panel.terminal.clear')"
        data-testid="terminal-btn-clear"
        @click="clear"
      >
        <Eraser class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-neutral-mid hover:text-neutral-fg"
        :class="state.ptyAlive ? '' : 'opacity-30'"
        :disabled="!state.ptyAlive"
        :title="t('panel.terminal.kill')"
        data-testid="terminal-btn-kill"
        @click="killTerminal"
      >
        <Square class="size-3.5" />
      </Button>
    </div>
    <!-- xterm 挂载点（relative 包裹浮动按钮）。纯黑圆角块嵌在 drawer 深底上
         （demo .terminal-mock：#000 + radius 8px + padding 12px）。 -->
    <div class="relative m-2 min-h-0 flex-1 rounded bg-black">
      <div data-testid="terminal-xterm" ref="xtermContainer" class="h-full p-3" />
      <!-- 选区浮动按钮（Phase 4 联动 1：选中输出 → 发给 AI） -->
      <Transition name="fade">
        <Button
          v-if="hasSelection"
          variant="ghost"
          data-testid="terminal-send-to-ai"
          class="absolute z-10 flex items-center gap-1 rounded-sm bg-accent px-2 py-1 text-xs text-accent-fg shadow-lg"
          :style="{ top: selectionPos.top + 'px', left: selectionPos.left + 'px' }"
          @click="sendSelectionToAI"
        >
          <MessageSquare class="size-3" />
          {{ t('panel.terminal.sendToAI') }}
        </Button>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, toRef, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Eraser, Square, MessageSquare } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { useTerminal, replayChunks, type TerminalBuffer } from '@/composables/features/terminal/useTerminal'
import { useSessionStore } from '@/stores/session'
import { useComposerInjectionStore } from '@/composables/panel/composer-injection-store'
import { getSettingsStore } from '@xyz-agent/core'
import { darkTerminalTheme } from '@/composables/terminal/terminal-themes'

/**
 * xterm 默认字体栈（canvas 渲染，不能用 CSS 变量 var()——canvas 不解析）。
 * 项目首选 JetBrains Mono 但未加载 webfont，canvas 回退到系统等宽字体 Menlo（macOS）/ Monaco。
 * 用户可在 Settings → Terminal 用 fontFamily 覆盖。
 */
const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'
const DEFAULT_FONT_SIZE = 13
const DEFAULT_SCROLLBACK = 5000
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()
const xtermContainer = ref<HTMLDivElement | null>(null)

const terminal = useTerminal(toRef(props, 'sessionId'))
const state = terminal.current
const composerInjection = useComposerInjectionStore()
const settingsStore = getSettingsStore()

/** 从 settings store 的 terminalConfig 解析 xterm 渲染选项。config 未加载时用默认值。 */
function resolveXtermFontOptions() {
  const cfg = settingsStore.terminalConfig.value?.config
  return {
    fontFamily: cfg && cfg.fontFamily.trim() !== '' ? cfg.fontFamily : DEFAULT_FONT_FAMILY,
    fontSize: cfg?.fontSize ?? DEFAULT_FONT_SIZE,
    scrollback: cfg?.scrollback ?? DEFAULT_SCROLLBACK,
    cursorStyle: cfg?.cursorStyle ?? 'bar',
  }
}

// Phase 4 联动 1：选区浮动按钮状态
const hasSelection = ref(false)
const selectionPos = ref({ top: 0, left: 0 })

let xterm: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
// 版本回放指针（D-6.2，替代 W14 的逻辑索引指针）：本视图已回放的 chunk 总数
// （= buffer.version 语义，单调）。mount / 切 session 时归零（全量回放），
// 之后每次 flush 监听按「指针 → 当前版本」增量 write。指针是视图私有状态：
// 模块级 buffer 跨组件存活，多个视图各自维护自己的回放进度。
let replayedVersion = 0
// 本视图的 flush 监听反注册（mount 注册 / unmount 与切 session 反注册）
let unregisterFlush: (() => void) | null = null

/** 取 session cwd（spawn 用）。 */
function getSessionCwd(): string | undefined {
  if (!props.sessionId) return undefined
  const sessionStore = useSessionStore()
  return sessionStore.list.find((s) => s.id === props.sessionId)?.cwd
}

/** 初始化 xterm 实例 + addons。返回创建的 fitAddon（供调用方访问，绕过 TS 控制流不跨函数窄化）。 */
function initXterm(): FitAddon | null {
  if (!xtermContainer.value || xterm) return null

  const fit = new FitAddon()
  fitAddon = fit
  const fontOpts = resolveXtermFontOptions()
  const term = new Terminal({
    fontSize: fontOpts.fontSize,
    fontFamily: fontOpts.fontFamily,
    cursorStyle: fontOpts.cursorStyle,
    cursorBlink: true,
    scrollback: fontOpts.scrollback,
    allowProposedApi: true,
    theme: darkTerminalTheme,
  })
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.loadAddon(new SearchAddon())
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  term.open(xtermContainer.value)

  // 用户输入 → 写入 PTY
  term.onData((data) => {
    terminal.writeToTerminal(data)
  })

  // resize：fit 后通知 runtime PTY resize
  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    terminal.resizeTerminal(cols, rows)
  })

  // Phase 4 联动 1：选区变化 → 更新浮动按钮显隐 + 定位
  term.onSelectionChange(() => {
    const sel = term.getSelection()
    if (sel && sel.trim().length > 0) {
      const pos = term.getSelectionPosition()
      hasSelection.value = true
      // 估算浮动按钮位置（选区末行下方）。xterm 的 cell 尺寸约 fontSize * 0.6（宽）/ 1.2（高）
      // 粗略定位到选区结束位置右下方，精确度足够（不需像素级）。
      const cellHeight = 16 // ≈ fontSize 13 * 1.2 line-height
      const cellWidth = 8 // ≈ fontSize 13 * 0.6
      selectionPos.value = {
        top: (pos?.end.y ?? 0) * cellHeight + cellHeight,
        left: (pos?.end.x ?? 0) * cellWidth,
      }
    } else {
      hasSelection.value = false
    }
  })

  // 容器尺寸变化 → fit（闭包捕获局部 fit，绕过模块级 fitAddon 的控制流问题）
  resizeObserver = new ResizeObserver(() => {
    try {
      fit.fit()
    } catch (e) {
      // best-effort：fit 在容器未渲染时（尺寸为 0）会抛错，降级为不调整——下次 ResizeObserver 回调会重试
      console.debug('[terminal] fit skipped (container size 0)', e)
    }
  })
  resizeObserver.observe(xtermContainer.value)

  // 赋值到模块级（replayScrollback / dispose 用）。fit 不存模块级（用闭包/返回值传递）。
  xterm = term
  return fit
}

/**
 * 版本回放（D-6.2）：把 buffer 中 fromVersion（含）之后 append 的 chunk 合并为单次 write。
 * fromVersion=0 = 全量回放（mount / 切 session）；fromVersion=本视图指针 = 增量（flush 监听）。
 * replayChunks 幂等（E6-b：重复回放只是重写既有内容），指针随 buffer.version 前进。
 */
function replayFrom(fromVersion: number, buffer: TerminalBuffer): void {
  if (!xterm) return
  const merged = replayChunks(buffer, fromVersion)
  if (merged === null) return
  xterm.write(merged)
  replayedVersion = buffer.version
}

/** flush 监听回调：模块级 flush 完成后按本视图指针增量回放（替代 W14 的 watch 链）。 */
function onFlushed(buffer: TerminalBuffer): void {
  replayFrom(replayedVersion, buffer)
}

/** 清屏（清 xterm + scrollback 当前分区）。 */
function clear(): void {
  xterm?.clear()
}

/** Phase 4 联动 1：选中文本 → 注入 composer「发给 AI」。 */
function sendSelectionToAI(): void {
  const text = xterm?.getSelection()
  if (!text) return
  composerInjection.requestInjection({
    target: 'current',
    text,
    sessionId: props.sessionId,
  })
  hasSelection.value = false
}

onMounted(async () => {
  if (!props.sessionId) return
  await nextTick()
  const fit = initXterm()
  if (!xterm || !fit) return

  // 全量回放模块级分区历史（切回 mount 场景：切走期间累积的输出在此补齐）
  replayFrom(0, terminal.current.value.buffer)
  // 注册 flush 监听：之后的输出经模块级订阅 → flush → 本监听增量回放
  // （先全量回放再注册：回放指针锚定到当前版本，增量不重复不遗漏）
  unregisterFlush = terminal.registerFlushListener(props.sessionId, onFlushed)

  // 若 PTY 未活，发 spawn
  const partition = state.value
  if (!partition.ptyAlive) {
    const cwd = getSessionCwd()
    const dims = fit.proposeDimensions()
    const cols = dims?.cols ?? partition.cols
    const rows = dims?.rows ?? partition.rows
    void terminal.spawnTerminal(cwd, cols, rows)
  }
  terminal.attachTerminal()

  // 初次 fit（容器尺寸稳定后）
  try {
    fit.fit()
  } catch (e) {
    // best-effort：mount 瞬间容器尺寸为 0 时 fit 抛错，ResizeObserver 后续回调会补偿
    console.debug('[terminal] initial fit skipped (container size 0)', e)
  }
})

onBeforeUnmount(() => {
  unregisterFlush?.()
  unregisterFlush = null
  resizeObserver?.disconnect()
  resizeObserver = null
  xterm?.dispose()
  xterm = null
  fitAddon = null
  replayedVersion = 0
})

// Settings → Terminal 配置变化（字体/字号/scrollback/cursorStyle）：动态应用到已挂载的 xterm。
// mount 时若 config 尚未加载（null），会用默认值 init；config 广播到达后此处补偿更新。
watch(
  () => settingsStore.terminalConfig.value,
  () => {
    if (!xterm) return
    const opts = resolveXtermFontOptions()
    xterm.options.fontSize = opts.fontSize
    xterm.options.fontFamily = opts.fontFamily
    xterm.options.scrollback = opts.scrollback
    xterm.options.cursorStyle = opts.cursorStyle
    // 字号/字体变化后 cell 尺寸变，需重新 fit 同步 PTY resize
    try {
      fitAddon?.fit()
    } catch (e) {
      // best-effort：config 变化时容器若未渲染（如 tab 不可见）fit 抛错，降级为不调整——下次可见时 ResizeObserver 补偿
      console.debug('[terminal] refit skipped after config change', e)
    }
  },
)

// sessionId 变化（切 session）：重新 init xterm + 回放新分区 + spawn（若需要）
watch(
  () => props.sessionId,
  async (sid) => {
    if (!sid) return
    // 切 session 视为重新挂载：反注册旧监听 + dispose 旧 xterm，重 init
    unregisterFlush?.()
    unregisterFlush = null
    resizeObserver?.disconnect()
    xterm?.dispose()
    xterm = null
    fitAddon = null
    replayedVersion = 0
    await nextTick()
    const fit2 = initXterm()
    if (!xterm || !fit2) return
    replayFrom(0, terminal.current.value.buffer)
    unregisterFlush = terminal.registerFlushListener(sid, onFlushed)
    const partition = state.value
    if (!partition.ptyAlive) {
      const cwd = getSessionCwd()
      const dims = fit2.proposeDimensions()
      void terminal.spawnTerminal(cwd, dims?.cols ?? partition.cols, dims?.rows ?? partition.rows)
    }
    terminal.attachTerminal()
    try {
      fit2.fit()
    } catch (e) {
      // best-effort：session 切换瞬间容器尺寸为 0 时 fit 抛错，ResizeObserver 后续回调会补偿
      console.debug('[terminal] refit skipped (container size 0)', e)
    }
  },
)

const { killTerminal } = terminal
</script>

<style scoped>
/* escape hatch：Vue Transition 类（Tailwind 无法表达），浮动按钮淡入淡出 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
