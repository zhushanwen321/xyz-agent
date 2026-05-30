export type SessionStatus = 'active' | 'idle'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  gitBranch?: string
  status: SessionStatus
  lastActiveAt: number
  modelId: string
  tokenCount: number
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
