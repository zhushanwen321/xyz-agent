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
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
