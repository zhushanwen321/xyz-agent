/**
 * workspaceStore — 前端状态层（#4，模板 stores/session.ts）。
 *
 * 持有 recent-workspaces 记录，提供 load() + defaultCwd computed。
 *
 * INV-6 时序守护（system-architecture.md §9 + #4 AC-4.3）：
 * useSidebar.initApp 必须在 presetCwd 之前 await workspaceStore.load()——
 * 否则首屏默认 cwd 拿空（useNewTaskFlow.resolveDefaultCwd 读 store.records 时未 fill）。
 *
 * 降级（#4 AC-4.5）：load() RPC reject → records=[] 不抛错（UI 显空态，不阻断 presetCwd）。
 *
 * 依赖方向：api/domains/workspace（无跨 store import——stores 间禁止互相 import）。
 */
import { computed, defineStore, ref } from '../../_deps.js'
import type { Ref, ComputedRef } from '../../_deps.js'
import type { RecentWorkspaceRecord } from '../../shared/workspace.js'
import * as workspaceApi from '../api/domains/workspace.js'

interface WorkspaceStoreState {
  records: Ref<RecentWorkspaceRecord[]>
  defaultCwd: ComputedRef<string | undefined>
  load: () => Promise<void>
}

export const useWorkspaceStore = defineStore('workspace', (): WorkspaceStoreState => {
  const records = ref<RecentWorkspaceRecord[]>([])

  /**
   * defaultCwd — 默认工作目录推断（UC-6）。
   * records[0]?.cwd（时间戳最新者，list 已倒序）。
   * 空数组 → undefined（AC-6.2，上层 fallback 不变）。
   */
  const defaultCwd = computed<string | undefined>(() => records.value[0]?.cwd)

  /**
   * load — 主动拉取最近记录（INV-6 必在 presetCwd 前 await）。
   * 降级：RPC reject → records=[]（AC-4.5）。
   */
  async function load(): Promise<void> {
    try {
      records.value = await workspaceApi.listRecent()
    } catch {
      records.value = [] // 降级：不抛错，UI 显空态
    }
  }

  return { records, defaultCwd, load }
}) as unknown as () => WorkspaceStoreState

/**
 * 骨架内部 type bridge：让 integration 文件的 `useWorkspaceStore() as unknown as WorkspaceStoreView`
 * 双 cast 能过 tsc（defineStore 骨架返 unknown，需 unknown 中介绕过结构检查）。
 */
export type WorkspaceStoreShape = WorkspaceStoreState
