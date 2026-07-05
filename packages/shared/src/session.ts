export type SessionStatus = 'active' | 'idle'

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
   * 隐藏 session（如公共 session）：不显示在 sidebar session 列表，仅供内部使用（如
   * landing 态命令源）。scanner listAll 过滤掉 hidden:true 的 session。
   */
  hidden?: boolean
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
