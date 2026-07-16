/**
 * 'dead'：pi 进程异常退出（前端收到 session.exited 后标记）。dead session 在侧栏置灰，
 * panel 显示「进程已退出」占位，点击「重新打开」触发 restore 重新 spawn pi。
 * 加在末尾以避免破坏现有 active/idle 序列消费方。
 */
export type SessionStatus = 'active' | 'idle' | 'dead'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  gitBranch?: string
  gitIsWorktree?: boolean
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
