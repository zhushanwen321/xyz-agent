/**
 * Workspace store —— 最近工作区记录（D-005/D-006）。
 *
 * 依赖方向：api/domains/workspace（stores 间禁止互相 import）。
 *
 * 数据源：runtime workspace.listRecent → RecentWorkspaceRecord[]（按 lastUsedAt 倒序）。
 * 前端不再从 session 列表派生 recentWorkspaces（W3 改接 workspaceStore）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'
import { listRecent } from '@/api/domains/workspace'

export const useWorkspaceStore = defineStore('workspace', () => {
  const records = ref<RecentWorkspaceRecord[]>([])

  /** 默认 cwd：最近活跃工作区（records[0]?.cwd，W3 取代 resolveDefaultCwd） */
  const defaultCwd = computed(() => records.value[0]?.cwd)

  /**
   * 加载最近工作区记录（initApp INV-6 时序：在 presetCwd 前调用）。
   * AC-4.5：RPC reject → records 置 [] 不抛（降级为空态，不阻断启动）。
   */
  async function load(): Promise<void> {
    try {
      records.value = await listRecent()
    } catch {
      records.value = []
    }
  }

  return { records, defaultCwd, load }
})
