/**
 * CommandPopover 打开主动拉（composer-symbol-system U2a / U3 renderer 部分）。
 *
 * 从 CommandPopover.vue 拆出（script 行数约束）：浮层 open false→true 边沿按 type 分路主动拉——
 * - slash：sessionApi.getCommands（查询即失效 + 最新值回填 commandStore）——兜底所有广播
 *   丢失/时序场景（设计 D4 路径 2，与 runtime 失效路幂等）；失败 warn 静默保留旧快照
 *   （ReplicatedState 退避语义同向，不空转）。
 * - subagent：subagentStore.loadSubagents（@ 候选源是 per-session 分区，打开时刷新最新 records）。
 * 节流（防浮层反复开关刷屏）：各路独立 1s 窗口，窗口内重复打开不重拉。
 */
import { watch } from 'vue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSubagentStore } from '@/stores/subagent'
import { session as sessionApi } from '@/api'

/** 打开主动拉节流窗口（浮层反复开关不刷屏） */
const FETCH_THROTTLE_MS = 1_000

export function useCommandPopoverOpenFetch(opts: {
  open: () => boolean
  type: () => 'file' | 'slash' | 'session' | 'subagent'
  sessionId: () => string | undefined
}): void {
  const commandStore = useCommandStore()
  const subagentStore = useSubagentStore()
  let lastSlashFetchAt = 0
  let lastSubagentFetchAt = 0
  watch(
    () => [opts.open(), opts.type()] as const,
    ([open], [prevOpen]) => {
      if (!open || prevOpen) return // 仅 false→true 边沿
      const sid = opts.sessionId()
      if (!sid) return // landing 态无数据源不拉（#/@ 候选为空不弹）
      if (opts.type() === 'slash') {
        if (Date.now() - lastSlashFetchAt < FETCH_THROTTLE_MS) return
        lastSlashFetchAt = Date.now()
        void sessionApi
          .getCommands(sid)
          .then((reply) => {
            commandStore.applyCommands(sid, reply.commands)
          })
          .catch((e: unknown) => {
            // 主动拉是兜底路：失败保留 commandStore 旧快照，不空转
            console.warn('[CommandPopover] slash open-fetch getCommands failed:', e)
          })
      } else if (opts.type() === 'subagent') {
        if (Date.now() - lastSubagentFetchAt < FETCH_THROTTLE_MS) return
        lastSubagentFetchAt = Date.now()
        void subagentStore.loadSubagents(sid)
      }
    },
  )
}
