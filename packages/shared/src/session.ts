/**
 * session 状态。
 *
 * 三态（进程级，runtime 维护）：
 * - 'active'：pi 进程存活且正在生成
 * - 'idle'：session 存在但 pi 未在生成（内存 session 默认态 / 磁盘历史 session 扫描态）
 * - 'dead'：pi 进程异常退出（前端收到 session.exited 后标记）。dead session 在侧栏置灰，
 *   panel 显示「进程已退出」占位，点击「重新打开」触发 restore 重新 spawn pi。
 *
 * 终态（W5，ADR 0036，来自 session_end entry）：
 * - 'done'：正常完成
 * - 'error'：LLM 出错
 * - 'stopped'：用户 abort / 进程崩溃
 *
 * 新增态加在末尾以避免破坏现有 active/idle/dead 序列消费方。
 * 历史 session（方案上线前产生，无 session_end entry）一律 idle（渐进迁移）。
 */
export type SessionStatus = 'active' | 'idle' | 'dead' | 'done' | 'error' | 'stopped'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  gitBranch?: string
  gitIsWorktree?: boolean
  /**
   * 是否处于 bare repo + worktree 结构（cwd 位于 .bare 目录下某级）。
   * 由 runtime WorkspaceDetector 检测填充（SessionService.toSummary / SessionScanner.scannedToSummary）。
   * 前端 Landing.vue 据此派生 DirSelectPopover「新建 worktree…」动作项显隐
   * （useNewTaskFlow.gitInfo.isBare）。未检测（undefined）→ 前端按 false 兜底。
   */
  isBareWorkspace?: boolean
  status: SessionStatus
  lastActiveAt: number
  modelId: string
  thinkingLevel?: string
  tokenCount: number
  /**
   * session JSONL 文件绝对路径。活跃 session 来自 pi get_state 的 sessionFile
   * （create 时写入 IManagedSessionView.sessionFilePath）；持久化 session 来自磁盘扫描
   * ScannedSessionMeta.filePath。可能为空——pi 延迟写入窗口（首条 assistant 消息前文件
   * 未落盘，规则 #6），此时 header 不展示文件名。前端 PanelHeader 据此渲染短文件名 +
   * 点击复制完整路径。
   */
  sessionFile?: string
  /**
   * 隐藏 session（如公共 session）：不显示在 sidebar session 列表，仅供内部使用（如
   * landing 态命令源）。scanner listAll 过滤掉 hidden:true 的 session。
   */
  hidden?: boolean
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
