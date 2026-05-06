export interface SessionSummary {
  id: string
  label: string
  cwd: string
  lastActiveAt: number  // Unix timestamp (Date.now()), NOT ISO string
  status: 'active' | 'idle'
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
