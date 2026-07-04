/**
 * DirSelectPopover.vue 改接点骨架（code-wiring-cheatsheet §F）。
 *
 * 真实文件 src-electron/renderer/src/components/new-task/DirSelectPopover.vue 改动：
 * - line 21 `import { recentWorkspaces } from '@/lib/utils'` → 删（改 import useWorkspaceStore）
 * - line 48 `const workspaces = computed(() => recentWorkspaces(session.list))`
 *   → `const workspaces = computed(() => workspaceStore.records)`
 * - filtered/isEmpty computed 不变（消费 workspaces，类型 RecentWorkspaceRecord[] 替代 RecentWorkspace[]）
 * - selectWorkspace(ws) emit('select', { cwd: ws.cwd }) 不变
 *
 * D-002 落地：数据源从 session 派生 → workspaceStore（SSOT）。
 * 形态/交互不变（requirements §5，无前端设计稿需求）。
 */
import { computed } from '../../_deps.js'
import type { ComputedRef } from '../../_deps.js'
import type { RecentWorkspaceRecord } from '../../shared/workspace.js'
import { useWorkspaceStore } from '../stores/workspace.js'

/** workspaces computed 改接：session 派生 → workspaceStore.records（D-002 SSOT）。 */
export function useDirSelectWorkspaces(): {
  workspaces: ComputedRef<RecentWorkspaceRecord[]>
} {
  // 真实：const workspaceStore = useWorkspaceStore()（setup 内调）
  const workspaceStore = useWorkspaceStore() as unknown as WorkspaceStoreView
  const workspaces = computed<RecentWorkspaceRecord[]>(() => workspaceStore.records)
  return { workspaces }
}

/** workspaceStore 视图（骨架简化，仅暴露 records）。 */
interface WorkspaceStoreView {
  records: RecentWorkspaceRecord[]
}
