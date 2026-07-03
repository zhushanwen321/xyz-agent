/**
 * useSidebar.ts initApp 改接点骨架（code-wiring-cheatsheet §F + INV-6 关键）。
 *
 * 真实文件 src-electron/renderer/src/composables/features/useSidebar.ts 改动（initApp 函数）：
 * 当前时序：startFlow()（同步）→ await loadSessions() → presetCwd(cwd)
 *   （cwd 来自 session.list 手动找 lastActiveAt 最大者，即 resolveDefaultCwd 语义）
 * 改后时序：startFlow() → await loadSessions() → await workspaceStore.load() → presetCwd(workspaceStore.defaultCwd)
 *
 * INV-6 守护（system-architecture.md §9 + #4 AC-4.3）：
 * await workspaceStore.load() 必须在 flow.presetCwd() **之前**——否则 presetCwd 读到的
 * workspaceStore.defaultCwd 是空（records 未 fill），首屏默认 cwd 拿空。
 *
 * 既有不变（useSidebar.ts:331 注释）：
 * - startFlow 先于 await loadSessions 同步执行（消除「渲染 Landing 时 state=idle」启动窗口）
 * - presetCwd 仅 landing 态生效（其他态 noop）
 */
import { useWorkspaceStore } from '../stores/workspace.js'

/** workspaceStore 视图（骨架简化，仅暴露 load + defaultCwd）。 */
interface WorkspaceStoreView {
  load: () => Promise<void>
  defaultCwd: string | undefined
}

interface NewTaskFlowView {
  presetCwd: (cwd: string) => void
}

/** initApp 改接 stub：验证 INV-6 时序（load 在 presetCwd 前 await）。 */
export async function initAppWireWorkspace(
  workspaceStore: WorkspaceStoreView,
  flow: NewTaskFlowView,
  loadSessions: () => Promise<void>,
): Promise<void> {
  // 真实：const flow = useNewTaskFlow(); const workspaceStore = useWorkspaceStore()
  // 1) startFlow 同步进 landing（既有，不变）
  // await flow.startFlow()  ← 既有
  await startFlowStub()

  // 2) loadSessions（既有，不变）
  await loadSessions()

  // 3) 【改后新增】await workspaceStore.load()（INV-6 必在 presetCwd 前）
  await workspaceStore.load()

  // 4) presetCwd（改后）：用 workspaceStore.defaultCwd 替代 session.list 派生
  if (workspaceStore.defaultCwd) {
    flow.presetCwd(workspaceStore.defaultCwd)
  }
}

/** flow.startFlow 既有逻辑叶子占位（骨架不展开）。 */
async function startFlowStub(): Promise<void> {
  // 真实：useNewTaskFlow().startFlow()——见 useNewTaskFlow.ts（既有，不变）
  // 骨架不模拟 state 机
  void (useWorkspaceStore as unknown)
}
