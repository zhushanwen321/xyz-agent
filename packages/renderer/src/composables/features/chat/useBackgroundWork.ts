/**
 * useBackgroundWork —— background 异步任务（subagent/workflow）谓词。
 *
 * 聚合 subagent + workflow 的 running/paused 判定，供 deriveStatus（working 态）与
 * handleCompletion（完成提示守卫）共用。单一真相源：未来新增 background 任务类型
 * （非 subagent/workflow）只需在 hasBackgroundWork 实现里注册判定。
 *
 * 为什么独立 composable 而非内联：
 *   hasBackgroundWork 原本内联在 useSessionDerivations.derivedStatus（L83），但
 *   handleCompletion（useCompletionNotify.ts）需复用同一判定。独立 composable 消除
 *   重复，避免两处判定漂移。
 */
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

export function useBackgroundWork() {
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /**
   * 指定 session 是否有 background 任务仍在跑（subagent running 或 workflow running/paused）。
   * subagent 无 paused 概念（只有 running/done/failed/cancelled/crashed）；workflow 有 paused（用户暂停）。
   * paused 算 background work：paused 不发 triggerTurn 续跑，主 agent 不会推进，仍是未完成状态。
   */
  function hasBackgroundWork(sessionId: string): boolean {
    return subagentStore.hasRunning(sessionId) || workflowStore.hasRunningOrPaused(sessionId)
  }

  return { hasBackgroundWork }
}
