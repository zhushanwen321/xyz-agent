<!--
  TerminalView —— drawer 集成终端的交互式渲染组件（Phase 3）。

  基于 xterm.js + addons（fit/web-links/search/unicode11），接收 sessionId prop。
  生命周期解耦（见 useTerminal 注释）：本组件只管 xterm 实例，PTY + scrollback 在 useTerminal。

  mount 流程：新建 xterm → 回放 scrollback → 若 !ptyAlive 发 spawn（cwd 取 session.cwd）→ attach
  unmount 流程：xterm.dispose()（PTY + buffer 不动，切回重放）
-->
<template>
  <div data-testid="terminal-view" class="flex h-full flex-col bg-black">
    <!-- 工具栏：clear / kill -->
    <div data-testid="terminal-toolbar" class="flex items-center gap-1 border-b border-white/10 px-2 py-1">
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-white/60 hover:text-white"
        :title="t('panel.terminal.clear')"
        data-testid="terminal-btn-clear"
        @click="clear"
      >
        <Eraser class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="size-6 shrink-0 rounded-sm p-0 text-white/60 hover:text-white"
        :class="state.ptyAlive ? '' : 'opacity-30'"
        :disabled="!state.ptyAlive"
        :title="t('panel.terminal.kill')"
        data-testid="terminal-btn-kill"
        @click="killTerminal"
      >
        <Square class="size-3.5" />
      </Button>
    </div>
    <!-- xterm 挂载点（relative 包裹浮动按钮） -->
    <div class="relative min-h-0 flex-1">
      <div data-testid="terminal-xterm" ref="xtermContainer" class="h-full p-1" />
      <!-- 选区浮动按钮（Phase 4 联动 1：选中输出 → 发给 AI） -->
      <Transition name="fade">
        <Button
          v-if="hasSelection"
          variant="ghost"
          data-testid="terminal-send-to-ai"
          class="absolute z-10 flex items-center gap-1 rounded-sm bg-accent px-2 py-1 text-xs text-white shadow-lg"
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
import { useTerminal } from '@/composables/features/useTerminal'
import { useSessionStore } from '@/stores/session'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()
const xtermContainer = ref<HTMLDivElement | null>(null)

const terminal = useTerminal(toRef(props, 'sessionId'))
const state = terminal.current
const composerInjection = useComposerInjectionStore()

// Phase 4 联动 1：选区浮动按钮状态
const hasSelection = ref(false)
const selectionPos = ref({ top: 0, left: 0 })

let xterm: Terminal | null = null
let resizeObserver: ResizeObserver | null = null
// scrollback 回放标记：mount 后把 buffer 全量 write 一次，之后只 write 增量
let replayedScrollbackLength = 0

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
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'var(--font-mono, Menlo, Monaco, "Courier New", monospace)',
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
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
  term.onResize(({ cols, rows }) => {
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

/** 回放 scrollback（mount 时全量，之后增量）。 */
function replayScrollback(): void {
  if (!xterm) return
  const partition = state.value
  const lines = partition.scrollback
  // 只 write 未回放的部分
  // 注意：scrollback 是按 PTY 输出 chunk 累积（非按行），replayedScrollbackLength 跟踪 chunk 数
  for (let i = replayedScrollbackLength; i < lines.length; i++) {
    xterm.write(lines[i])
  }
  replayedScrollbackLength = lines.length
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

  // 回放历史
  replayScrollback()

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
  resizeObserver?.disconnect()
  resizeObserver = null
  xterm?.dispose()
  xterm = null
  replayedScrollbackLength = 0
})

// 监听 scrollback 变化，增量 write 到 xterm（PTY 切走期间累积的输出，切回后实时 write）
watch(
  () => state.value.scrollback.length,
  () => {
    if (xterm) replayScrollback()
  },
)

// sessionId 变化（切 session）：重新 init xterm + 回放新分区 + spawn（若需要）
watch(
  () => props.sessionId,
  async (sid) => {
    if (!sid) return
    // 切 session 视为重新挂载：dispose 旧 xterm，重 init
    resizeObserver?.disconnect()
    xterm?.dispose()
    xterm = null
    replayedScrollbackLength = 0
    await nextTick()
    const fit2 = initXterm()
    if (!xterm || !fit2) return
    replayScrollback()
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
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
