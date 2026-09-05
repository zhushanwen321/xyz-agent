/**
 * CommandPopover 打开主动拉（composer-symbol-system U2a / U3 renderer 部分）。
 *
 * 从 CommandPopover.vue 拆出（script 行数约束）：浮层 open false→true 边沿按 type 分路主动拉——
 * - slash：sessionApi.getCommands（查询即失效 + 最新值回填 commandStore）——兜底所有广播
 *   丢失/时序场景（设计 D4 路径 2，与 runtime 失效路幂等）；失败 warn 静默保留旧快照
 *   （ReplicatedState 退避语义同向，不空转）。
 * - subagent：subagentStore.loadSubagents（@ 候选源是 per-session 分区，打开时刷新最新 records）。
 * - file：landing cwd 路（D2/D3）——无 sid 且有 cwd 时 getFileCandidatesByCwd 边沿拉，
 *   结果经 onCwdFileCandidates 回调写入 CommandPopover 本地 ref 进 items；失败（cwd 已删/权限，
 *   runtime not_found，见实施计划 §5 u2 偏差）降级空候选。panel（有 sid）不在此拉——file 候选
 *   走 command-popover-file-candidates 的 store 缓存路，双路并存会重复 RPC。
 * - session：不 open 拉（sessionStore 启动常驻 + 广播维护，D1/D7）。
 * 节流（防浮层反复开关刷屏）：各路独立 1s 窗口，窗口内重复打开不重拉。
 */
import { watch } from 'vue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSubagentStore } from '@/stores/subagent'
import { session as sessionApi } from '@/api'
import { getFileCandidatesByCwd } from '@xyz-agent/core/transport/api/domains/composer'
import type { FileNode } from '@xyz-agent/shared'

/** 打开主动拉节流窗口（浮层反复开关不刷屏） */
const FETCH_THROTTLE_MS = 1_000

export function useCommandPopoverOpenFetch(opts: {
  open: () => boolean
  type: () => 'file' | 'slash' | 'session' | 'subagent'
  sessionId: () => string | undefined
  /** landing 态当前选定目录（Composer 传 flow.currentCwd；file 路 cwd 通道专用，panel 不消费） */
  cwd: () => string | null | undefined
  /** file 路 landing 拉取结果回传（raw FileNode[]；消费侧 toFileCandidates 转候选形状后入 items） */
  onCwdFileCandidates: (nodes: FileNode[]) => void
}): void {
  const commandStore = useCommandStore()
  const subagentStore = useSubagentStore()
  let lastSlashFetchAt = 0
  let lastSubagentFetchAt = 0
  let lastFileCwdFetchAt = 0
  watch(
    () => [opts.open(), opts.type()] as const,
    ([open], [prevOpen]) => {
      if (!open || prevOpen) return // 仅 false→true 边沿
      const type = opts.type()
      const sid = opts.sessionId()
      if (type === 'slash') {
        if (!sid) return // landing 态无 session 通道不拉（slash 候选源 per-session）
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
      } else if (type === 'subagent') {
        if (!sid) return // @ 范围限当前 session（D3 拍板），landing 无数据源不拉（G3）
        if (Date.now() - lastSubagentFetchAt < FETCH_THROTTLE_MS) return
        lastSubagentFetchAt = Date.now()
        void subagentStore.loadSubagents(sid)
      } else if (type === 'file') {
        // D3 分路守卫：panel（有 sid）走 store 缓存路，open-fetch 不重复拉；
        // landing（无 sid）有 cwd 才拉（cwd 通道），两者皆无不拉（无数据源不弹，S4b）
        if (sid) return
        const cwd = opts.cwd()
        if (!cwd) return
        if (Date.now() - lastFileCwdFetchAt < FETCH_THROTTLE_MS) return
        lastFileCwdFetchAt = Date.now()
        void getFileCandidatesByCwd(cwd)
          .then((nodes) => opts.onCwdFileCandidates(nodes))
          .catch((e: unknown) => {
            // cwd 目录已删/权限失败（runtime not_found）→ 降级空候选（设计 §3.1 失败路径：无浮层 + warn 可排查）
            console.warn('[CommandPopover] file open-fetch getFileCandidatesByCwd failed:', e)
            opts.onCwdFileCandidates([])
          })
      }
    },
  )
}
