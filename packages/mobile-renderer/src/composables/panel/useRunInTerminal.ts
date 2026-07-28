/**
 * Phase 5 联动 2：bash 工具块「在终端运行」按钮逻辑（从 Block.vue 拆出，控 script 行数）。
 *
 * 职责：
 * - isBash：toolName === 'bash' 才显示按钮（联动 2 仅针对 shell 命令）
 * - runInTerminal：切 terminal tab + 入队写命令。TerminalView mount 后 PTY 就绪
 *   （terminal.alive）时 flush。焦点切换由 TerminalView mount 后 xterm.focus 隐式完成。
 *
 * writeQueue 延迟到 runInTerminal 内取（lazy）：Block 是高频渲染组件（每条 tool 消息一个），
 * setup 顶层调 Pinia store 会强制所有 mount Block 的测试都 setActivePinia。lazy 取避免污染。
 */
import { computed, type ComputedRef } from 'vue'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'

export function useRunInTerminal(params: {
  toolName: ComputedRef<string>
  argPath: ComputedRef<string>
  sessionId: ComputedRef<string | null | undefined>
  isRunning: ComputedRef<boolean>
}): {
  isBash: ComputedRef<boolean>
  runInTerminal: () => void
} {
  const sideDrawer = useSideDrawer()
  const isBash = computed(() => params.toolName.value === 'bash')

  /** 把 bash 命令填入 drawer 终端（不自动执行，用户回车确认）。 */
  function runInTerminal(): void {
    if (!params.sessionId.value || !params.argPath.value) return
    sideDrawer.open('terminal')
    useTerminalWriteQueueStore().enqueueWrite(params.sessionId.value, params.argPath.value)
  }

  return { isBash, runInTerminal }
}
