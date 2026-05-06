export interface SessionData {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
}

const sessions = new Map<string, SessionData>()

export function createSession(cwd: string): SessionData {
  const id = crypto.randomUUID()
  const session: SessionData = {
    id, cwd, label: `Session ${sessions.size + 1}`,
    modelId: 'default', createdAt: Date.now(),
    lastActiveAt: Date.now(), tokenCount: 0,
  }
  sessions.set(id, session)
  return session
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id)
}

export function listSessions(): SessionData[] {
  return Array.from(sessions.values())
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export function getSession(id: string): SessionData | undefined {
  return sessions.get(id)
}
