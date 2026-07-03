/**
 * useNewTaskFlow.ts 改接点骨架（code-wiring-cheatsheet §F）。
 *
 * 真实文件 src-electron/renderer/src/composables/features/useNewTaskFlow.ts 改动：
 * - line 21 `import { resolveDefaultCwd, deriveSessionLabel } from '@/lib/utils'`
 *   → resolveDefaultCwd 改 workspaceStore.defaultCwd（deriveSessionLabel 保留 import）
 * - submitFirstMessage 内 `const cwd = pendingCwd.value ?? resolveDefaultCwd(session.list)`
 *   → `const cwd = pendingCwd.value ?? workspaceStore.defaultCwd`
 *
 * D-002 落地：默认 cwd 推断数据源改接 workspaceStore。
 * UC-6 AC-6.2 不变：records 空 → defaultCwd undefined（上层 fallback 不变）。
 */
import { useWorkspaceStore } from '../stores/workspace.js'

/** 默认 cwd 推断改接：resolveDefaultCwd(session.list) → workspaceStore.defaultCwd。 */
export function resolveDefaultCwdFromWorkspace(): string | undefined {
  // 真实：const workspaceStore = useWorkspaceStore()（setup 内调）
  const workspaceStore = useWorkspaceStore() as unknown as WorkspaceStoreView
  return workspaceStore.defaultCwd
}

/** workspaceStore 视图（骨架简化，仅暴露 defaultCwd）。 */
interface WorkspaceStoreView {
  defaultCwd: string | undefined
}
